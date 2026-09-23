import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGemini2ApiServer } from '../src/gemini_2api.js';
import { createNoAuthGeminiProvider } from '../src/noauth_provider.js';

const MODEL = 'gemini-3.5-flash-thinking';
const INPUT = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
async function withServer(run, sendMessage) {
    const models = [];
    const server = createGemini2ApiServer({
        sendMessage:
            sendMessage ??
            (async (_prompt, model) => {
                models.push(model);
                return { text: 'OK' };
            }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const post = (body, method = 'generateContent', model = MODEL) =>
        fetch(`http://127.0.0.1:${server.address().port}/v1beta/models/${model}:${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    try {
        await run({ post, models });
    } finally {
        await server.shutdown({ gracePeriodMs: 50 });
    }
}

describe('request reasoning effort', () => {
    it('maps effort preferences for both JSON and SSE generation', async () => {
        await withServer(async ({ post, models }) => {
            for (const method of ['generateContent', 'streamGenerateContent']) {
                for (const [effort, expected] of [
                    ['none', 4],
                    ['minimal', 4],
                    ['low', 3],
                    ['medium', 2],
                    ['high', 1],
                    ['xhigh', 0],
                    ['max', 0],
                ]) {
                    const response = await post({ ...INPUT, reasoning_effort: effort }, method);
                    assert.equal(response.status, 200);
                    const body = await response.text();
                    assert.ok(!body.includes('"error"'), body);
                    assert.equal(models.at(-1), MODEL + '@think=' + expected);
                }
            }
        });
    });

    it('accepts camel-case, nested effort, and native Gemini thinking levels', async () => {
        await withServer(async ({ post, models }) => {
            for (const config of [
                { reasoningEffort: 'medium' },
                { reasoning: { effort: 'MEDIUM' } },
                { generationConfig: { thinkingConfig: { thinkingLevel: 'MEDIUM' } } },
                {
                    generation_config: {
                        thinking_config: { thinking_level: 'medium', include_thoughts: false },
                    },
                },
                {
                    reasoning_effort: 'medium',
                    generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } },
                },
            ]) {
                const response = await post({ ...INPUT, ...config });
                assert.equal(response.status, 200, JSON.stringify(config));
                await response.text();
                assert.equal(models.at(-1), MODEL + '@think=2');
            }
            for (const [level, expected] of [
                ['MINIMAL', 4],
                ['LOW', 3],
                ['HIGH', 0],
            ]) {
                const response = await post({
                    ...INPUT,
                    generationConfig: { thinkingConfig: { thinkingLevel: level } },
                });
                assert.equal(response.status, 200);
                await response.text();
                assert.equal(models.at(-1), MODEL + '@think=' + expected);
            }
        });
    });

    it('preserves the model default or suffix when no preference is supplied', async () => {
        await withServer(async ({ post, models }) => {
            for (const model of [MODEL, MODEL + '@think=3']) {
                for (const config of [
                    {},
                    { reasoning_effort: null },
                    { reasoning: {} },
                    {
                        generationConfig: {
                            thinkingConfig: { thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED' },
                        },
                    },
                ]) {
                    const response = await post({ ...INPUT, ...config }, 'generateContent', model);
                    assert.equal(response.status, 200);
                    await response.text();
                    assert.equal(models.at(-1), model);
                }
            }
        });
    });

    it('resolves conflicting controls by priority and lets request effort override the suffix', async () => {
        await withServer(async ({ post, models }) => {
            const matched = await post(
                { ...INPUT, reasoning_effort: 'medium' },
                'generateContent',
                MODEL + '@think=2'
            );
            assert.equal(matched.status, 200);
            await matched.text();
            const conflicting = [
                [{ reasoning_effort: 'medium' }, MODEL + '@think=0', 2],
                [{ reasoning_effort: 'low', reasoningEffort: 'high' }, MODEL, 3],
                [{ reasoning_effort: 'low', reasoning: { effort: 'medium' } }, MODEL, 3],
                [
                    {
                        reasoning_effort: 'high',
                        generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
                    },
                    MODEL,
                    1,
                ],
                [
                    {
                        generationConfig: {
                            thinkingConfig: { thinkingLevel: 'LOW', thinking_level: 'HIGH' },
                        },
                    },
                    MODEL,
                    3,
                ],
                [
                    {
                        generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
                        generation_config: { thinking_config: { thinking_level: 'HIGH' } },
                    },
                    MODEL,
                    3,
                ],
            ];
            for (const [config, model, expected] of conflicting) {
                const response = await post({ ...INPUT, ...config }, 'generateContent', model);
                assert.equal(response.status, 200);
                assert.ok(response.headers.get('x-gemini-adjusted-parameters'));
                assert.equal(response.headers.get('x-gemini-thinking-mode'), String(expected));
                await response.text();
                assert.equal(models.at(-1), MODEL + '@think=' + expected);
            }
            assert.equal(models.length, conflicting.length + 1);
        });
    });

    it('falls back from invalid efforts and ignores unsupported optional controls', async () => {
        await withServer(async ({ post, models }) => {
            for (const config of [
                ...[0, false, '', 'constructor', '__proto__', {}, []].map((reasoning_effort) => ({
                    reasoning_effort,
                })),
                { reasoning: 'high' },
                { reasoning: [] },
                { reasoning: { mode: 'pro' } },
                { generationConfig: { thinkingConfig: 'high' } },
                { generationConfig: { thinkingConfig: { thinkingLevel: 'xhigh' } } },
                { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } },
                { generationConfig: { thinkingConfig: { includeThoughts: true } } },
            ]) {
                const response = await post({ ...INPUT, ...config });
                assert.equal(response.status, 200, JSON.stringify(config));
                assert.ok(response.headers.get('x-gemini-adjusted-parameters'));
                await response.text();
                assert.equal(models.at(-1), MODEL);
            }
        });
    });

    it('validates nested countTokens controls without changing the prompt estimate', async () => {
        await withServer(async ({ post, models }) => {
            const original = await post(INPUT, 'countTokens');
            const mapped = await post(
                {
                    generateContentRequest: {
                        ...INPUT,
                        model: 'models/' + MODEL,
                        reasoning: { effort: 'medium' },
                    },
                },
                'countTokens'
            );
            assert.equal(mapped.status, 200);
            assert.equal((await original.json()).totalTokens, (await mapped.json()).totalTokens);
            const conflict = await post(
                { ...INPUT, reasoning_effort: 'high' },
                'countTokens',
                MODEL + '@think=2'
            );
            assert.equal(conflict.status, 200);
            assert.equal(conflict.headers.get('x-gemini-thinking-mode'), '1');
            await conflict.text();
            assert.equal(models.length, 0);
        });
    });

    it('uses lower-priority valid settings when a preferred field is malformed', async () => {
        await withServer(async ({ post, models }) => {
            const response = await post({
                ...INPUT,
                reasoning_effort: 'unsupported',
                generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('x-gemini-thinking-mode'), '0');
            assert.match(response.headers.get('x-gemini-adjusted-parameters'), /reasoning_effort/);
            await response.text();
            assert.equal(models.at(-1), MODEL + '@think=0');
        });
    });

    it('ignores JSON key order when selecting between native field spellings', async () => {
        await withServer(async ({ post, models }) => {
            const response = await post({
                ...INPUT,
                generationConfig: {
                    thinking_config: { thinking_level: 'LOW' },
                    thinkingConfig: { thinkingLevel: 'HIGH' },
                },
            });
            assert.equal(response.status, 200);
            await response.text();
            assert.equal(models.at(-1), MODEL + '@think=0');
        });
    });

    it('writes the mapped level into the actual upstream request payload', async () => {
        let payload;
        const sendMessage = createNoAuthGeminiProvider({
            fetchImpl: async (url, options) => {
                if (url.endsWith('/app'))
                    return new Response('boq_assistant-bard-web-server_20260921.20_p0');
                payload = JSON.parse(JSON.parse(options.body.get('f.req'))[1]);
                const candidate = ['answer', ['OK']];
                candidate[8] = [2];
                return new Response(
                    JSON.stringify([
                        ['wrb.fr', null, JSON.stringify([null, null, null, null, [candidate]])],
                    ])
                );
            },
        });
        try {
            await withServer(async ({ post }) => {
                for (const [config, expected] of [
                    [{ reasoning_effort: 'high' }, 1],
                    [{ generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } }, 0],
                    [
                        {
                            reasoning_effort: 'invalid',
                            generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
                        },
                        3,
                    ],
                ]) {
                    const response = await post({ ...INPUT, ...config });
                    assert.equal(response.status, 200);
                    assert.equal((await response.json()).candidates[0].content.parts[0].text, 'OK');
                    assert.deepEqual(payload[17], [[expected]]);
                    assert.equal(payload[79], 2);
                }
            }, sendMessage);
        } finally {
            sendMessage.close();
        }
    });
});
