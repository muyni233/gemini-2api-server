import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';
import { createGemini2ApiServer } from '../src/gemini_2api.js';
import { UpstreamError } from '../src/noauth_provider.js';

const MODEL = 'gemini-3.8-flash';
const INPUT = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };
const TOOL = { functionDeclarations: [{ name: 'weather', parameters: { type: 'object' } }] };
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const events = (text) =>
    text
        .split('\n\n')
        .filter((part) => part.startsWith('data: '))
        .map((part) => JSON.parse(part.slice(6)));
async function withServer(options, run) {
    const server = createGemini2ApiServer({
        sendMessage: async () => ({ text: 'OK' }),
        ...options,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (body = INPUT, method = 'generateContent', model = MODEL, headers = {}) =>
        fetch(`${url}/v1beta/models/${model}:${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    try {
        await run({ server, url, post });
    } finally {
        await server.shutdown({ gracePeriodMs: 50 });
    }
}

describe('HTTP boundaries and compatibility', () => {
    it('validates limits and origins before starting a listener', () => {
        for (const options of [
            { maxBodyBytes: 0 },
            { requestTimeoutMs: NaN },
            { maxConcurrentRequests: -1 },
            { maxPendingSseBytes: Infinity },
            { allowedOrigins: ['null'] },
            { apiKey: 123 },
            { sendMessage: 42 },
        ]) {
            assert.throws(() => createGemini2ApiServer(options), TypeError);
        }
    });

    it('allows loopback browser clients and rejects arbitrary web origins by default', async () => {
        await withServer({}, async ({ url, post }) => {
            const allowed = await post(INPUT, undefined, undefined, {
                Origin: 'http://localhost:3000',
            });
            assert.equal(allowed.status, 200);
            assert.equal(
                allowed.headers.get('access-control-allow-origin'),
                'http://localhost:3000'
            );
            await allowed.text();
            for (const origin of [
                'https://example.com',
                'null',
                'http://localhost.evil.example',
                'ftp://localhost',
            ]) {
                const denied = await post(INPUT, undefined, undefined, { Origin: origin });
                assert.equal(denied.status, 403);
                assert.equal(denied.headers.get('access-control-allow-origin'), null);
                await denied.text();
            }
            const preflight = await fetch(url + '/v1beta/models', {
                method: 'OPTIONS',
                headers: { Origin: 'http://127.0.0.1:5173' },
            });
            assert.equal(preflight.status, 204);
            assert.match(
                preflight.headers.get('access-control-allow-headers'),
                /X-Goog-Api-Client/
            );
        });
    });

    it('supports explicitly configured browser origins', async () => {
        await withServer({ allowedOrigins: ['https://client.example'] }, async ({ post }) => {
            const response = await post(INPUT, undefined, undefined, {
                Origin: 'https://client.example',
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('vary'), 'Origin');
            await response.text();
        });
    });

    it('enforces optional API keys on models and generation while keeping health checks public', async () => {
        await withServer({ apiKey: 'test-only-key' }, async ({ url, post }) => {
            const health = await fetch(url + '/healthz');
            assert.equal((await health.json()).auth, 'api-key');
            const missing = await fetch(url + '/v1beta/models');
            assert.equal(missing.status, 401);
            await missing.text();
            const wrong = await post(INPUT, undefined, undefined, {
                Authorization: 'Bearer wrong',
            });
            assert.equal(wrong.status, 401);
            await wrong.text();
            for (const headers of [
                { Authorization: 'Bearer test-only-key' },
                { 'X-Goog-Api-Key': 'test-only-key' },
                { 'X-Api-Key': 'test-only-key' },
            ]) {
                const response = await post(INPUT, undefined, undefined, headers);
                assert.equal(response.status, 200);
                await response.text();
            }
            const query = await fetch(url + '/v1beta/models?key=test-only-key');
            assert.equal(query.status, 200);
            await query.text();
        });
    });

    it('normalizes optional model suffixes and still rejects unknown base models', async () => {
        await withServer({}, async ({ url, post }) => {
            for (const method of ['generateContent', 'countTokens']) {
                for (const suffix of ['@anything', '@think=4junk', '@think=5', '@think=-1']) {
                    const response = await post(INPUT, method, MODEL + suffix);
                    assert.equal(response.status, 200);
                    assert.match(
                        response.headers.get('x-gemini-adjusted-parameters'),
                        /model\.%40think/
                    );
                    await response.text();
                }
                const unknown = await post(INPUT, method, 'constructor');
                assert.equal(unknown.status, 404);
                await unknown.text();
            }
            const response = await fetch(url + '/v1beta/models/' + MODEL + '@think=2');
            const metadata = await response.json();
            assert.equal(response.status, 200);
            assert.ok(metadata.supportedGenerationMethods.includes('countTokens'));
            assert.match(metadata.description, /unverified/);
        });
    });

    it('supports countTokens generateContentRequest and labels its estimate', async () => {
        await withServer(
            {
                sendMessage: () => {
                    throw new Error('countTokens must stay local');
                },
            },
            async ({ post }) => {
                const nested = await post(
                    {
                        generateContentRequest: {
                            ...INPUT,
                            model: 'models/' + MODEL,
                            systemInstruction: { parts: [{ text: 'A system instruction' }] },
                            tools: [TOOL],
                        },
                    },
                    'countTokens'
                );
                const plain = await post(INPUT, 'countTokens');
                assert.equal(nested.status, 200);
                assert.equal(nested.headers.get('x-gemini-token-count'), 'estimated');
                assert.ok((await nested.json()).totalTokens > (await plain.json()).totalTokens);
                const conflicting = await post(
                    { ...INPUT, generateContentRequest: INPUT },
                    'countTokens'
                );
                assert.equal(conflicting.status, 200);
                assert.match(conflicting.headers.get('x-gemini-adjusted-parameters'), /contents/);
                await conflicting.text();
                const mismatch = await post(
                    { generateContentRequest: { ...INPUT, model: 'gemini-auto' } },
                    'countTokens'
                );
                assert.equal(mismatch.status, 200);
                assert.match(
                    mismatch.headers.get('x-gemini-adjusted-parameters'),
                    /generateContentRequest.model/
                );
                await mismatch.text();
            }
        );
    });

    it('rejects malformed content and mixed media before invoking the provider', async () => {
        let calls = 0;
        await withServer(
            {
                sendMessage: async () => {
                    calls++;
                    return { text: 'OK' };
                },
            },
            async ({ post }) => {
                const bodies = [
                    { contents: [{ parts: [{ text: 'x', inlineData: { data: 'AQ==' } }] }] },
                    { contents: [{ parts: [{ functionCall: { name: 'weather', args: [] } }] }] },
                    { contents: [{ parts: [{ text: '  ' }] }] },
                ];
                for (const body of bodies) {
                    const response = await post(body);
                    assert.equal(response.status, 400, JSON.stringify(body));
                    await response.text();
                }
                assert.equal(calls, 0);
            }
        );
    });

    it('ignores unsupported optional controls and reports adjustments', async () => {
        await withServer({}, async ({ post }) => {
            for (const config of [
                {
                    generationConfig: {
                        temperature: 0,
                        responseMimeType: 'application/json',
                        maxOutputTokens: 1,
                    },
                },
                { generationConfig: 'invalid' },
                { cachedContent: 'cachedContents/example' },
                { safetySettings: [{ category: 'test' }] },
                { tools: [{ googleSearch: {} }] },
                { tools: 'invalid' },
                { tools: [null, { functionDeclarations: 'invalid' }] },
                { toolConfig: 'ANY' },
                { toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
                { tools: [TOOL, TOOL] },
            ]) {
                const response = await post({ ...INPUT, ...config });
                assert.equal(response.status, 200, JSON.stringify(config));
                assert.ok(response.headers.get('x-gemini-adjusted-parameters'));
                assert.equal((await response.json()).candidates[0].content.parts[0].text, 'OK');
            }
        });
    });

    it('does not broaden a malformed tool allowlist or mode', async () => {
        const text = '<function_call>{"name":"weather","args":{}}</function_call>';
        await withServer({ sendMessage: async () => ({ text }) }, async ({ post }) => {
            for (const config of [
                { allowedFunctionNames: ['missing'] },
                { allowedFunctionNames: [42] },
                { allowedFunctionNames: {} },
                { mode: 'NONNE' },
                { mode: false },
            ]) {
                const response = await post({
                    ...INPUT,
                    tools: [TOOL],
                    toolConfig: { functionCallingConfig: config },
                });
                assert.equal(response.status, 200);
                assert.ok(response.headers.get('x-gemini-adjusted-parameters'));
                assert.deepEqual((await response.json()).candidates[0].content.parts, [{ text }]);
            }
            const partial = await post({
                ...INPUT,
                tools: [TOOL],
                toolConfig: {
                    functionCallingConfig: {
                        mode: 'ANY',
                        allowedFunctionNames: ['missing', 'weather'],
                    },
                },
            });
            assert.equal(partial.status, 200);
            assert.equal(
                (await partial.json()).candidates[0].content.parts[0].functionCall.name,
                'weather'
            );
        });
    });

    it('keeps valid function declarations while dropping malformed or duplicate ones', async () => {
        const text = '<function_call>{"name":"weather","args":{}}</function_call>';
        await withServer({ sendMessage: async () => ({ text }) }, async ({ post }) => {
            const response = await post({
                ...INPUT,
                tools: [
                    {
                        functionDeclarations: [
                            null,
                            { name: '' },
                            { name: 'broken', parameters: [] },
                            { name: 'weather', parameters: {} },
                            { name: 'weather', parameters: {} },
                        ],
                    },
                ],
                toolConfig: {
                    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: 'weather' },
                },
            });
            assert.equal(response.status, 200);
            assert.ok(response.headers.get('x-gemini-adjusted-parameters'));
            assert.equal(
                (await response.json()).candidates[0].content.parts[0].functionCall.name,
                'weather'
            );
        });
    });

    it('bounds and escapes adjustment headers for arbitrary input field names', async () => {
        const config = Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => ['\r\n\ud800\u4e2d'.repeat(100) + index, true])
        );
        await withServer({}, async ({ post }) => {
            const response = await post({ ...INPUT, generationConfig: config });
            assert.equal(response.status, 200);
            const header = response.headers.get('x-gemini-adjusted-parameters');
            assert.ok(header.length < 1900);
            assert.ok(!/[\r\n]/.test(header));
            for (const item of header.split(', '))
                assert.doesNotThrow(() => decodeURIComponent(item));
            await response.text();
        });
    });

    it('rejects invalid JSON, invalid UTF-8, and compressed requests', async () => {
        await withServer({}, async ({ url, post }) => {
            for (const body of ['null', '[]', '{', Buffer.from([0xff])]) {
                const response = await fetch(`${url}/v1beta/models/${MODEL}:generateContent`, {
                    method: 'POST',
                    body,
                });
                assert.equal(response.status, 400);
                await response.text();
            }
            const response = await post(INPUT, undefined, undefined, {
                'Content-Encoding': 'gzip',
            });
            assert.equal(response.status, 400);
            await response.text();
        });
    });

    for (const contentLength of [true, false]) {
        it(
            `rejects an oversized ${contentLength ? 'declared' : 'chunked'} body before the sender finishes`,
            { timeout: 3000 },
            async () => {
                await withServer({ maxBodyBytes: 32 }, async ({ url }) => {
                    let request;
                    const result = new Promise((resolve, reject) => {
                        request = httpRequest(
                            `${url}/v1beta/models/${MODEL}:generateContent`,
                            {
                                method: 'POST',
                                headers: contentLength ? { 'Content-Length': '1000000' } : {},
                            },
                            (response) => {
                                response.resume();
                                response.on('end', () => resolve(response.statusCode));
                            }
                        );
                        request.on('error', reject);
                        if (contentLength) request.flushHeaders();
                        else request.write('x'.repeat(64));
                    });
                    try {
                        assert.equal(await result, 413);
                        assert.equal(request.writableEnded, false);
                    } finally {
                        request.destroy();
                    }
                });
            }
        );
    }

    it('does not turn a quoted function example into an executable call', async () => {
        const text = 'Example: <function_call>{"name":"weather","args":{}}</function_call>';
        await withServer({ sendMessage: async () => ({ text }) }, async ({ post }) => {
            const response = await post({ ...INPUT, tools: [TOOL] });
            assert.deepEqual((await response.json()).candidates[0].content.parts, [{ text }]);
            const required = await post({
                ...INPUT,
                tools: [TOOL],
                toolConfig: { functionCallingConfig: { mode: 'ANY' } },
            });
            assert.equal(required.status, 502);
            await required.text();
        });
    });

    it('preserves nested arguments and function history in a tool round trip', async () => {
        let prompt;
        await withServer(
            {
                sendMessage: async (value) => {
                    prompt = value;
                    return {
                        text: 'function_call\n{"name":"weather","args":{"location":{"city":"Shanghai"}}}',
                    };
                },
            },
            async ({ post }) => {
                const response = await post({
                    tools: [TOOL],
                    contents: [
                        ...INPUT.contents,
                        {
                            role: 'model',
                            parts: [
                                { functionCall: { name: 'weather', args: { city: 'Shanghai' } } },
                            ],
                        },
                        {
                            role: 'user',
                            parts: [
                                {
                                    functionResponse: {
                                        name: 'weather',
                                        response: { temperature: 20 },
                                    },
                                },
                            ],
                        },
                    ],
                });
                assert.equal(response.status, 200);
                assert.deepEqual(
                    (await response.json()).candidates[0].content.parts[0].functionCall.args,
                    { location: { city: 'Shanghai' } }
                );
                assert.match(prompt, /<function_call>\{"name":"weather"/);
                assert.match(prompt, /Tool response for weather/);
            }
        );
    });

    it('rejects invalid provider results rather than returning success', async () => {
        for (const value of [
            { text: 42 },
            [],
            { text: ' ' },
            { text: 'partial', truncated: true },
        ]) {
            await withServer({ sendMessage: async () => value }, async ({ post }) => {
                const response = await post();
                assert.equal(response.status, 502);
                await response.text();
            });
        }
    });

    it('preserves upstream rate-limit and timeout status codes', async () => {
        for (const [status, name] of [
            [429, 'RESOURCE_EXHAUSTED'],
            [503, 'UNAVAILABLE'],
            [504, 'DEADLINE_EXCEEDED'],
        ]) {
            await withServer(
                {
                    sendMessage: async () => {
                        throw new UpstreamError('upstream failure', { status, retryAfter: '30' });
                    },
                },
                async ({ post }) => {
                    const response = await post();
                    assert.equal(response.status, status);
                    assert.equal(response.headers.get('retry-after'), '30');
                    assert.equal((await response.json()).error.status, name);
                }
            );
        }
    });

    it('ends a revised or truncated SSE response with an error and never STOP', async () => {
        for (const result of [{ text: 'Goodbye' }, { text: 'Hello', truncated: true }]) {
            await withServer(
                {
                    sendMessage: async (_p, _m, _f, _s, update) => {
                        update('Hello');
                        return result;
                    },
                },
                async ({ post }) => {
                    const response = await post(INPUT, 'streamGenerateContent');
                    const data = events(await response.text());
                    assert.equal(data[0].candidates[0].content.parts[0].text, 'Hello');
                    assert.equal(data.at(-1).error.code, 502);
                    assert.ok(
                        !data.some((event) => event.candidates?.[0]?.finishReason === 'STOP')
                    );
                }
            );
        }
    });

    for (const method of ['generateContent', 'streamGenerateContent']) {
        it(
            `aborts upstream work when a ${method} client disconnects`,
            { timeout: 3000 },
            async () => {
                const entered = deferred();
                const aborted = deferred();
                await withServer(
                    {
                        sendMessage: (_p, _m, _f, signal) =>
                            new Promise((_resolve, reject) => {
                                entered.resolve();
                                signal.addEventListener(
                                    'abort',
                                    () => {
                                        aborted.resolve(signal.aborted);
                                        reject(signal.reason);
                                    },
                                    { once: true }
                                );
                            }),
                    },
                    async ({ url }) => {
                        const request = httpRequest(`${url}/v1beta/models/${MODEL}:${method}`, {
                            method: 'POST',
                        });
                        request.on('error', () => {});
                        request.end(JSON.stringify(INPUT));
                        await entered.promise;
                        request.destroy();
                        assert.equal(await aborted.promise, true);
                    }
                );
            }
        );

        it(`times out a stuck provider for ${method}`, async () => {
            let signal;
            await withServer(
                {
                    requestTimeoutMs: 25,
                    sendMessage: (_p, _m, _f, value) => {
                        signal = value;
                        return new Promise(() => {});
                    },
                },
                async ({ post }) => {
                    const response = await post(INPUT, method);
                    const error =
                        method === 'generateContent'
                            ? (await response.json()).error
                            : events(await response.text()).at(-1).error;
                    assert.equal(error.code, 504);
                    assert.equal(signal.aborted, true);
                }
            );
        });
    }

    it('limits concurrent generations and releases capacity after completion', async () => {
        const gate = deferred();
        const entered = deferred();
        await withServer(
            {
                maxConcurrentRequests: 1,
                sendMessage: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { text: 'OK' };
                },
            },
            async ({ post }) => {
                const first = post();
                await entered.promise;
                const second = await post();
                assert.equal(second.status, 429);
                assert.equal(second.headers.get('retry-after'), '1');
                await second.text();
                gate.resolve();
                assert.equal((await first).status, 200);
                await (await first).text();
                const third = await post();
                assert.equal(third.status, 200);
                await third.text();
            }
        );
    });

    it('bounds graceful shutdown and aborts active upstream work', { timeout: 3000 }, async () => {
        const entered = deferred();
        let signal;
        await withServer(
            {
                sendMessage: (_p, _m, _f, value) => {
                    signal = value;
                    entered.resolve();
                    return new Promise(() => {});
                },
            },
            async ({ server, post }) => {
                const pending = post().catch(() => null);
                await entered.promise;
                const shutdown = server.shutdown({ gracePeriodMs: 25 });
                assert.equal(server.shutdown(), shutdown);
                await shutdown;
                assert.equal(signal.aborted, true);
                await pending;
            }
        );
    });
});
