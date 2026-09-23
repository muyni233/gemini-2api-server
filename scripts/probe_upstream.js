import { performance } from 'node:perf_hooks';
import { createNoAuthGeminiProvider, DEFAULT_NOAUTH_MODEL } from '../src/noauth_provider.js';

// One anonymous, synthetic request. Never prints cookies, prompts, or raw RPC data.
const model = process.argv[2] || DEFAULT_NOAUTH_MODEL;
const started = performance.now();
const requests = [];
let updates = 0;
let firstUpdateMs;
const provider = createNoAuthGeminiProvider({
    generationTimeoutMs: 45_000,
    fetchImpl: async (url, options) => {
        const since = performance.now();
        const endpoint = new URL(url);
        const kind = endpoint.pathname.endsWith('/app') ? 'build-label-page' : 'generation';
        try {
            const response = await fetch(url, options);
            requests.push({
                kind,
                status: response.status,
                headersMs: Math.round(performance.now() - since),
                ...(kind === 'generation' ? { buildLabel: endpoint.searchParams.get('bl') } : {}),
            });
            return response;
        } catch (error) {
            requests.push({ kind, error: error.cause?.code || error.name });
            throw error;
        }
    },
});
try {
    const result = await provider('Reply with exactly OK.', model, [], undefined, () => {
        updates++;
        firstUpdateMs ??= Math.round(performance.now() - started);
    });
    const ok = !result.truncated && !!result.text?.trim();
    console.log(
        JSON.stringify(
            {
                ok,
                requestedAlias: model,
                backendModelVerified: false,
                elapsedMs: Math.round(performance.now() - started),
                firstUpdateMs,
                updates,
                responseCharacters: result.text.length,
                ...(result.error ? { error: result.error.message } : {}),
                requests,
            },
            null,
            2
        )
    );
    if (!ok) process.exitCode = 1;
} catch (error) {
    console.log(
        JSON.stringify(
            {
                ok: false,
                requestedAlias: model,
                status: error.status,
                error: error.message,
                elapsedMs: Math.round(performance.now() - started),
                requests,
            },
            null,
            2
        )
    );
    process.exitCode = 1;
}
