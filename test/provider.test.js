import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { createNoAuthGeminiProvider, resolveNoAuthModel } from '../src/noauth_provider.js';

const BL = 'boq_assistant-bard-web-server_20260921.20_p0';
const MODEL = 'gemini-3.8-flash';
const candidate = (text, id = 'answer', completion) => {
    const value = [id, [text]];
    if (completion !== undefined) value[8] = [completion];
    return value;
};
const row = (...candidates) => [
    'wrb.fr',
    null,
    JSON.stringify([null, null, null, null, candidates]),
];
const frame = (...rows) => JSON.stringify(rows) + '\n';
const errorRow = (code) => [
    'wrb.fr',
    null,
    null,
    null,
    null,
    [null, null, [['type.googleapis.com/assistant.api.BardErrorInfo', [code]]]],
];
function fixture(generate, options = {}) {
    const requests = [];
    const pages = [];
    const send = createNoAuthGeminiProvider({
        ...options,
        fetchImpl: async (url, init) => {
            if (url.endsWith('/app')) {
                pages.push(init);
                return new Response(BL);
            }
            requests.push({ url, ...init });
            return generate(requests.length, init);
        },
    });
    return { send, requests, pages };
}
const invoke = (send, onUpdate, signal) => send('Say hello', MODEL, [], signal, onUpdate);

describe('anonymous upstream protocol', () => {
    it('decodes short replies in every envelope and keeps a stable candidate ID', async () => {
        const { send } = fixture(
            () =>
                new Response(
                    frame(
                        ['metadata'],
                        row(candidate('A'), candidate('Other', 'alternative')),
                        row(
                            candidate('Other longer', 'alternative'),
                            candidate('Answer', 'answer', 2)
                        )
                    )
                )
        );
        const updates = [];
        assert.equal((await invoke(send, (text) => updates.push(text))).text, 'Answer');
        assert.deepEqual(updates, ['A', 'Answer']);
    });

    it('handles UTF-8 split at every byte, CRLF, a prologue, and a final line without newline', async () => {
        const text = '  你好🌍\n';
        const data = new TextEncoder().encode(
            ")]}'\r\n\r\n" + frame(row(candidate(text, 'answer', 2))).trimEnd()
        );
        const { send } = fixture(
            () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            for (const byte of data) controller.enqueue(Uint8Array.of(byte));
                            controller.close();
                        },
                    })
                )
        );
        const updates = [];
        assert.equal((await invoke(send, (value) => updates.push(value))).text, text);
        assert.equal(updates.join(''), text);
    });

    it('does not treat an explanation of BardErrorInfo as an upstream rejection', async () => {
        const text = 'BardErrorInfo [1037] means a quota error.';
        const { send, requests } = fixture(() => new Response(frame(row(candidate(text)))));
        assert.equal((await invoke(send)).text, text);
        assert.equal(requests.length, 1);
    });

    it('rejects malformed candidates instead of reading characters as array fields', async () => {
        const { send } = fixture(() => new Response(frame(row('invalid candidate'))));
        await assert.rejects(invoke(send), /no text candidate/);
    });

    it('preserves ordinary URLs that share an artifact prefix', async () => {
        const text = 'See http://googleusercontent.com/card_content/docs';
        const snapshots = Array.from({ length: text.length }, (_, i) =>
            frame(row(candidate(text.slice(0, i + 1))))
        ).join('');
        const { send } = fixture(() => new Response(snapshots));
        const result = await invoke(send, () => {});
        assert.equal(result.truncated, undefined);
        assert.equal(result.text, text);
    });

    it('decodes multiline length-prefixed frames using UTF-16 units including emoji', async () => {
        const first = '\n' + JSON.stringify([row(candidate('你好🌍'))], null, 2) + '\n';
        const last = '\n' + JSON.stringify([row(candidate('你好🌍!', 'answer', 2))]) + '\n';
        const encoded = new TextEncoder().encode(
            ")]}'\n" + first.length + first + last.length + last
        );
        const { send } = fixture(
            () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            for (let index = 0; index < encoded.length; index += 3)
                                controller.enqueue(encoded.slice(index, index + 3));
                            controller.close();
                        },
                    })
                )
        );
        assert.equal((await invoke(send)).text, '你好🌍!');
    });

    it('rejects incomplete and oversized length-prefixed frames', async () => {
        for (const body of ['100\n[]', '999999999\n', '100']) {
            const { send } = fixture(() => new Response(body));
            await assert.rejects(invoke(send), /length-prefixed|too large/);
        }
    });

    for (const [code, status] of [
        [1037, 429],
        [1060, 503],
        [1013, 503],
        [1050, 502],
    ]) {
        it(`classifies RPC error ${code} without repeating generation`, async () => {
            const { send, requests } = fixture(() => new Response(frame(errorRow(code))));
            await assert.rejects(
                invoke(send),
                (error) => error.status === status && error.code === code
            );
            assert.equal(requests.length, 1);
        });
    }

    it('refreshes the build label once for an outdated protocol and cancels the rejected body', async () => {
        let cancelled = false;
        const rejectedBody = new ReadableStream({
            cancel() {
                cancelled = true;
            },
        });
        const { send, requests, pages } = fixture((attempt) =>
            attempt === 1
                ? new Response(rejectedBody, { status: 405 })
                : new Response(frame(row(candidate('OK'))))
        );
        assert.equal((await invoke(send)).text, 'OK');
        assert.equal(cancelled, true);
        assert.equal(requests.length, 2);
        assert.equal(pages.length, 2);
    });

    it('retries structured protocol error 1052 before any text', async () => {
        const { send, requests } = fixture(
            (attempt) =>
                new Response(attempt === 1 ? frame(errorRow(1052)) : frame(row(candidate('OK'))))
        );
        assert.equal((await invoke(send)).text, 'OK');
        assert.equal(requests.length, 2);
    });

    it('never retries after a partial candidate, even if the next RPC suggests refreshing', async () => {
        const { send, requests } = fixture(
            () => new Response(frame(row(candidate('Partial')), errorRow(1052)))
        );
        const updates = [];
        const result = await invoke(send, (text) => updates.push(text));
        assert.equal(result.truncated, true);
        assert.equal(requests.length, 1);
        assert.deepEqual(updates, ['Partial']);
    });

    it('detects clean EOF before a reported completion marker', async () => {
        const { send } = fixture(() => new Response(frame(row(candidate('Partial', 'answer', 1)))));
        const result = await invoke(send);
        assert.equal(result.truncated, true);
        assert.match(result.error.message, /completion marker/);
    });

    it('rejects trailing invalid JSON and invalid UTF-8', async () => {
        for (const body of ['[["wrb.fr",', Uint8Array.of(255)]) {
            const { send } = fixture(() => new Response(body));
            await assert.rejects(invoke(send), /malformed|encoded data/i);
        }
    });

    it('does not silently replace streamed text with a revised candidate', async () => {
        const { send } = fixture(
            () => new Response(frame(row(candidate('Hello'))) + frame(row(candidate('Goodbye'))))
        );
        const result = await invoke(send, () => {});
        assert.equal(result.truncated, true);
        assert.match(result.error.message, /revised/);
        assert.equal((await invoke(send)).text, 'Goodbye');
    });

    it('preserves whitespace and removes execution artifacts without retracting snapshots', async () => {
        const artifact = '```python?code_reference&code_event_index=0\nprint(1)\n```\n';
        const text = '  Answer\n' + artifact + 'Done\n';
        const snapshots = Array.from({ length: text.length }, (_, i) =>
            frame(row(candidate(text.slice(0, i + 1))))
        ).join('');
        const { send } = fixture(() => new Response(snapshots));
        let previous = '';
        const result = await invoke(send, (next) => {
            assert.ok(next.startsWith(previous), 'updates must be append-only');
            assert.ok(!next.includes('?code_'));
            previous = next;
        });
        assert.equal(result.truncated, undefined);
        assert.equal(result.text, '  Answer\nDone\n');
        assert.equal(previous, result.text);
    });

    it('awaits a slow consumer instead of buffering subsequent updates', async () => {
        const { send } = fixture(
            () => new Response(frame(row(candidate('a')), row(candidate('ab'))))
        );
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const updates = [];
        const result = invoke(send, async (text) => {
            updates.push(text);
            await gate;
        });
        await delay(5);
        assert.deepEqual(updates, ['a']);
        release();
        await result;
        assert.deepEqual(updates, ['a', 'ab']);
    });

    it('bounds both a single frame and the total upstream response', async () => {
        for (const options of [{ maxFrameChars: 32 }, { maxResponseBytes: 32 }]) {
            const { send } = fixture(
                () => new Response(frame(row(candidate('x'.repeat(100))))),
                options
            );
            await assert.rejects(invoke(send), /too large|size limit/);
        }
    });

    it('forwards HTTP 429 and Retry-After without an immediate retry', async () => {
        const { send, requests } = fixture(
            () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })
        );
        await assert.rejects(
            invoke(send),
            (error) => error.status === 429 && error.retryAfter === '120'
        );
        assert.equal(requests.length, 1);
    });

    it('shares concurrent build-label fetches and refreshes them after TTL expiry', async () => {
        let time = 100;
        const { send, pages } = fixture(() => new Response(frame(row(candidate('OK')))), {
            now: () => time,
            buildLabelTtlMs: 50,
        });
        await Promise.all(Array.from({ length: 12 }, () => invoke(send)));
        assert.equal(pages.length, 1);
        time += 51;
        await invoke(send);
        assert.equal(pages.length, 2);
    });

    it('waits for the complete build number when page chunks split its digits', async () => {
        const buildLabel = 'boq_assistant-bard-web-server_20260921.20_p12';
        let selectedBuild;
        const send = createNoAuthGeminiProvider({
            fetchImpl: async (url) => {
                if (url.endsWith('/app'))
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(
                                    new TextEncoder().encode('"' + buildLabel.slice(0, -1))
                                );
                                controller.enqueue(
                                    new TextEncoder().encode(buildLabel.slice(-1) + '"')
                                );
                                controller.close();
                            },
                        })
                    );
                selectedBuild = new URL(url).searchParams.get('bl');
                return new Response(frame(row(candidate('OK'))));
            },
        });
        assert.equal((await invoke(send)).text, 'OK');
        assert.equal(selectedBuild, buildLabel);
    });

    it('caches failed page lookups briefly instead of fetching on every request', async () => {
        let pages = 0;
        let time = 0;
        const send = createNoAuthGeminiProvider({
            now: () => time,
            buildLabelFailureTtlMs: 50,
            fetchImpl: async (url) => {
                if (url.endsWith('/app')) {
                    pages++;
                    throw new Error('page unavailable');
                }
                return new Response(frame(row(candidate('OK'))));
            },
        });
        await invoke(send);
        await invoke(send);
        assert.equal(pages, 1);
        time = 51;
        await invoke(send);
        assert.equal(pages, 2);
    });

    it('cancels one build-label waiter without poisoning another request', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let pages = 0;
        const send = createNoAuthGeminiProvider({
            fetchImpl: async (url) => {
                if (url.endsWith('/app')) {
                    pages++;
                    await gate;
                    return new Response(BL);
                }
                return new Response(frame(row(candidate('OK'))));
            },
        });
        const controller = new AbortController();
        const cancelled = invoke(send, undefined, controller.signal);
        const survivor = invoke(send);
        controller.abort();
        await assert.rejects(cancelled, { name: 'AbortError' });
        release();
        assert.equal((await survivor).text, 'OK');
        assert.equal(pages, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });

    it('releases reader locks, parent listeners, and timeout timers after success', async () => {
        let response;
        let requestSignal;
        const { send } = fixture(
            (_, init) => {
                requestSignal = init.signal;
                response = new Response(frame(row(candidate('OK'))));
                return response;
            },
            { generationTimeoutMs: 40 }
        );
        const controller = new AbortController();
        await invoke(send, undefined, controller.signal);
        assert.equal(response.body.locked, false);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        await delay(60);
        assert.equal(requestSignal.aborted, false);
    });

    it('times out a stalled reader and releases its lock', async () => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            })
        );
        const { send } = fixture(() => response, { generationTimeoutMs: 20 });
        // Keep a handle alive because production deadline timers are intentionally unref'ed.
        const keepAlive = setTimeout(() => {}, 1000);
        try {
            await assert.rejects(invoke(send), (error) => error.status === 504);
        } finally {
            clearTimeout(keepAlive);
        }
        assert.equal(cancelled, true);
        assert.equal(response.body.locked, false);
    });

    it('times out an update consumer that never resolves', async () => {
        const response = new Response(frame(row(candidate('OK'))));
        const { send } = fixture(() => response, { generationTimeoutMs: 20 });
        const keepAlive = setTimeout(() => {}, 1000);
        try {
            await assert.rejects(
                invoke(send, () => new Promise(() => {})),
                (error) => error.status === 504
            );
        } finally {
            clearTimeout(keepAlive);
        }
        assert.equal(response.body.locked, false);
    });

    it('validates every model suffix and does not fall back on prototype property names', async () => {
        for (const model of [
            'constructor',
            '__proto__',
            'unknown',
            MODEL + '@bad',
            MODEL + '@think=2junk',
            MODEL + '@think=-1',
            MODEL + '@think=5',
        ]) {
            assert.throws(() => resolveNoAuthModel(model));
        }
        const { send, requests } = fixture(() => new Response(frame(row(candidate('OK')))));
        await send('Hello', MODEL + '@think=2');
        const inner = JSON.parse(JSON.parse(requests[0].body.get('f.req'))[1]);
        assert.equal(inner[79], 1);
        assert.deepEqual(inner[17], [[2]]);
        await assert.rejects(send('Hello', MODEL, [{ name: 'image' }]), /text only/);
        assert.equal(requests.length, 1);
    });

    it('closing a provider aborts its shared page lookup and all waiters', async () => {
        let pageSignal;
        const send = createNoAuthGeminiProvider({
            fetchImpl: (_url, init) =>
                new Promise((_resolve, reject) => {
                    pageSignal = init.signal;
                    init.signal.addEventListener('abort', () => reject(init.signal.reason), {
                        once: true,
                    });
                }),
        });
        const first = invoke(send);
        const second = invoke(send);
        send.close();
        await assert.rejects(first, (error) => error.status === 503);
        await assert.rejects(second, (error) => error.status === 503);
        assert.equal(pageSignal.aborted, true);
        await assert.rejects(invoke(send), /closed/);
    });
});
