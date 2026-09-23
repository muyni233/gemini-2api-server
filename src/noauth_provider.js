import { randomUUID } from 'node:crypto';
import { createDeadline, positiveInteger, withAbort } from './async_utils.js';
import { cleanSnapshot, RpcStreamDecoder, UpstreamError } from './upstream_stream.js';

// Protocol lineage: https://github.com/Sophomoresty/gemini-web2api
// (gemini_web2api/gemini.py and models.py), via Gemini Nexus's noauth provider.

export { UpstreamError } from './upstream_stream.js';
export const DEFAULT_NOAUTH_MODEL = 'gemini-3.8-flash';

// Compatibility aliases select Web UI modes, not verified backend model versions.
// In particular anonymous Pro requests may be routed to Flash by Google.
const MODELS = Object.freeze({
    'gemini-3.8-flash': { mode: 1, think: 4 },
    'gemini-3.7-flash': { mode: 1, think: 4 },
    'gemini-3.5-flash': { mode: 1, think: 4 },
    'gemini-3.5-flash-thinking': { mode: 2, think: 0 },
    'gemini-3.1-pro': { mode: 3, think: 4 },
    'gemini-3.1-pro-enhanced': { mode: 3, think: 4, extra: { 31: 2, 80: 3 } },
    'gemini-auto': { mode: 4, think: 4 },
    'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0 },
    'gemini-flash-lite': { mode: 6, think: 4 },
});
export const NOAUTH_MODEL_NAMES = Object.freeze(Object.keys(MODELS));
const FALLBACK_BL = 'boq_assistant-bard-web-server_20260921.20_p0';
const BL_PATTERN = /boq_assistant-bard-web-server_\d+\.\d+_p\d+/;
const COMPLETE_BL_PATTERN = /boq_assistant-bard-web-server_\d+\.\d+_p\d+(?=\D)/;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export function resolveNoAuthModel(model = DEFAULT_NOAUTH_MODEL) {
    const match = /^([^@]+)(?:@think=([0-4]))?$/.exec(String(model));
    if (!match)
        throw new UpstreamError('Model suffix must be @think=0 through @think=4.', { status: 400 });
    if (!Object.hasOwn(MODELS, match[1]))
        throw new UpstreamError(`Model ${match[1]} not found.`, { status: 404 });
    const config = MODELS[match[1]];
    return {
        ...config,
        ...(config.extra ? { extra: { ...config.extra } } : {}),
        name: match[1],
        think: match[2] === undefined ? config.think : Number(match[2]),
    };
}

function buildPayload(prompt, config) {
    const inner = new Array(102).fill(null);
    inner[0] = [prompt, 0, null, null, null, null, 0];
    inner[1] = ['en'];
    inner[2] = ['', '', '', null, null, null, null, null, null, ''];
    inner[6] = [0];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[config.think]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    inner[41] = [2];
    inner[53] = 0;
    inner[59] = randomUUID();
    inner[61] = [];
    inner[68] = 1;
    inner[79] = config.mode;
    for (const [key, value] of Object.entries(config.extra || {})) inner[key] = value;
    return new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) });
}

function endpoint(bl) {
    const params = new URLSearchParams({
        bl,
        hl: 'en',
        _reqid: String(Date.now() % 1000000),
        rt: 'c',
    });
    return `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`;
}

function timeoutError() {
    return new UpstreamError('Gemini upstream request timed out.', { status: 504 });
}

async function cancelBody(body) {
    try {
        await body?.cancel();
    } catch {
        /* The transport may already have aborted. */
    }
}

export function createNoAuthGeminiProvider({
    fetchImpl = (...args) => fetch(...args),
    now = Date.now,
    generationTimeoutMs = 180_000,
    pageTimeoutMs = 15_000,
    buildLabelTtlMs = 3_600_000,
    buildLabelFailureTtlMs = 30_000,
    maxResponseBytes = 16 * 1024 * 1024,
    maxFrameChars = 4 * 1024 * 1024,
} = {}) {
    for (const [name, value] of Object.entries({
        generationTimeoutMs,
        pageTimeoutMs,
        buildLabelTtlMs,
        buildLabelFailureTtlMs,
        maxResponseBytes,
        maxFrameChars,
    }))
        positiveInteger(value, name);
    if (typeof fetchImpl !== 'function' || typeof now !== 'function')
        throw new TypeError('fetchImpl and now must be functions.');
    let cachedBl = FALLBACK_BL;
    let expiresAt = 0;
    let revision = 0;
    let refreshing;
    const lifetime = new AbortController();
    const activeDeadlines = new Set();

    async function refreshBl() {
        const deadline = createDeadline(lifetime.signal, pageTimeoutMs, timeoutError());
        let reader;
        let found = false;
        try {
            const response = await fetchImpl('https://gemini.google.com/app', {
                headers: { 'User-Agent': USER_AGENT },
                credentials: 'omit',
                signal: deadline.signal,
            });
            if (!response.ok || !response.body) {
                await cancelBody(response.body);
                return;
            }
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let tail = '';
            let size = 0;
            for (;;) {
                const { done, value } = await withAbort(reader.read(), deadline.signal);
                size += value?.byteLength || 0;
                if (size > 4 * 1024 * 1024) break;
                tail += decoder.decode(value, { stream: !done });
                // The final build-number digits can straddle network chunks.
                // Wait for a delimiter or EOF before committing the cached label.
                const match = tail.match(done ? BL_PATTERN : COMPLETE_BL_PATTERN);
                if (match) {
                    cachedBl = match[0];
                    found = true;
                    break;
                }
                if (done) break;
                tail = tail.slice(-256);
            }
        } catch (error) {
            if (process.env.GEMINI_2API_DEBUG === '1')
                console.debug('[Gemini] Build label refresh failed:', error.message);
        } finally {
            if (reader) {
                try {
                    await reader.cancel();
                } catch {
                    /* Already aborted. */
                }
                reader.releaseLock();
            }
            deadline.dispose();
            revision++;
            expiresAt = now() + (found ? buildLabelTtlMs : buildLabelFailureTtlMs);
        }
    }

    async function getBl(signal, rejectedRevision) {
        signal.throwIfAborted();
        const needsRefresh =
            rejectedRevision === undefined ? now() >= expiresAt : revision === rejectedRevision;
        if (needsRefresh || refreshing) {
            if (!refreshing)
                refreshing = refreshBl().finally(() => {
                    refreshing = undefined;
                });
            await withAbort(refreshing, signal);
        }
        return { bl: cachedBl, revision };
    }

    const sendMessage = async function (prompt, model, files = [], parentSignal, onUpdate) {
        lifetime.signal.throwIfAborted();
        if (typeof prompt !== 'string' || !prompt.trim())
            throw new UpstreamError('Prompt must be non-empty text.', { status: 400 });
        if (!Array.isArray(files) || files.length)
            throw new UpstreamError('Anonymous Gemini supports text only.', { status: 400 });
        const config = resolveNoAuthModel(model);
        const deadline = createDeadline(parentSignal, generationTimeoutMs, timeoutError());
        activeDeadlines.add(deadline);
        const signal = deadline.signal;
        const body = buildPayload(prompt, config);
        let previousRevision;
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const build = await getBl(signal, previousRevision);
                previousRevision = build.revision;
                signal.throwIfAborted();
                let reader;
                let rawText = '';
                let emittedText = '';
                let selectedId;
                let completion;
                let bytes = 0;
                const parser = new RpcStreamDecoder(maxFrameChars);
                try {
                    const response = await fetchImpl(endpoint(build.bl), {
                        method: 'POST',
                        signal,
                        credentials: 'omit',
                        body,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            Origin: 'https://gemini.google.com',
                            Referer: 'https://gemini.google.com/app',
                            'X-Same-Domain': '1',
                            'User-Agent': USER_AGENT,
                        },
                    });
                    if (!response.ok) {
                        await cancelBody(response.body);
                        throw new UpstreamError(
                            `Gemini upstream returned HTTP ${response.status}.`,
                            {
                                status: [429, 503, 504].includes(response.status)
                                    ? response.status
                                    : 502,
                                refreshBuild: response.status === 405,
                                retryAfter: response.headers.get('retry-after') || undefined,
                            }
                        );
                    }
                    if (!response.body)
                        throw new UpstreamError('Gemini upstream returned no response body.');
                    reader = response.body.getReader();
                    for (;;) {
                        signal.throwIfAborted();
                        const { done, value } = await withAbort(reader.read(), signal);
                        bytes += value?.byteLength || 0;
                        if (bytes > maxResponseBytes)
                            throw new UpstreamError(
                                'Gemini response exceeds the configured size limit.'
                            );
                        for (const event of parser.push(value, done)) {
                            if (event.error) throw event.error;
                            const candidates = event.candidates.filter(
                                (candidate) =>
                                    Array.isArray(candidate) &&
                                    Array.isArray(candidate[1]) &&
                                    typeof candidate[1][0] === 'string' &&
                                    (candidate[0] == null || typeof candidate[0] === 'string')
                            );
                            const candidate =
                                selectedId === undefined
                                    ? candidates.find((c) => typeof c?.[1]?.[0] === 'string')
                                    : candidates.find((c) => (c?.[0] ?? null) === selectedId);
                            if (!candidate || typeof candidate[1]?.[0] !== 'string') continue;
                            if (selectedId === undefined) selectedId = candidate[0] ?? null;
                            rawText = candidate[1][0];
                            if ([1, 2].includes(candidate[8]?.[0])) completion = candidate[8][0];
                            const next = cleanSnapshot(rawText);
                            if (onUpdate && next !== emittedText) {
                                if (!next.startsWith(emittedText))
                                    throw new UpstreamError(
                                        'Gemini revised text that was already streamed.'
                                    );
                                await withAbort(onUpdate(next), signal);
                                emittedText = next;
                            }
                        }
                        if (done) break;
                    }
                    if (completion === 1)
                        throw new UpstreamError(
                            'Gemini stream ended before its completion marker.'
                        );
                    const text = cleanSnapshot(rawText, true);
                    if (!text.trim())
                        throw new UpstreamError(
                            'Gemini returned no text candidate (possible protocol, access, or media-only response).'
                        );
                    if (onUpdate && text !== emittedText) {
                        if (!text.startsWith(emittedText))
                            throw new UpstreamError(
                                'Gemini final text differs from the streamed response.'
                            );
                        await withAbort(onUpdate(text), signal);
                    }
                    return { text };
                } catch (error) {
                    if (signal.aborted) throw signal.reason;
                    // A new generation must never be appended after output from a failed one.
                    if (attempt === 0 && !rawText && error.refreshBuild === true) continue;
                    if (rawText)
                        return { text: cleanSnapshot(rawText, true), truncated: true, error };
                    throw error instanceof UpstreamError
                        ? error
                        : new UpstreamError(
                              `Failed to read Gemini upstream: ${error.message || error}`
                          );
                } finally {
                    if (reader) {
                        try {
                            await reader.cancel();
                        } catch {
                            /* Already closed or aborted. */
                        }
                        reader.releaseLock();
                    }
                }
            }
            throw new UpstreamError('Gemini upstream retry exhausted.');
        } finally {
            deadline.dispose();
            activeDeadlines.delete(deadline);
        }
    };
    sendMessage.close = () => {
        const error = new UpstreamError('Gemini provider is closed.', { status: 503 });
        lifetime.abort(error);
        for (const deadline of activeDeadlines) deadline.abort(error);
    };
    return sendMessage;
}

export const sendNoAuthGeminiMessage = createNoAuthGeminiProvider();
