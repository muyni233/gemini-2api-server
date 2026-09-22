/**
 * "No-Auth Gemini" provider — embedded port of the gemini-web2api anonymous
 * StreamGenerate protocol (gemini_web2api/gemini.py + models.py).
 *
 * Talks directly to gemini.google.com without any API key, Google sign-in,
 * or a separate local server. bl (build label) is auto-fetched from the
 * page, mirroring web2api's auto-update + 405 retry.
 *
 * Multi-turn is simulated by folding history into the prompt (same as
 * web2api). The current anonymous page exposes the same resumable upload
 * tokens used by Gemini Web, so media references can be uploaded before
 * StreamGenerate without a Google login.
 */
export const DEFAULT_NOAUTH_MODEL = 'gemini-3.8-flash';

function debugLog(...args) {
    if (process.env.GEMINI_2API_DEBUG === '1') console.debug(...args);
}

// MODE_CATEGORY enum from Gemini frontend JS (gemini-web2api models.py):
// 1=FAST 2=THINKING 3=PRO 4=AUTO 5=FAST_DYNAMIC_THINKING 6=FLASH_LITE
const MODELS = Object.freeze({
    'gemini-3.8-flash': Object.freeze({ mode: 1, think: 4 }),
    'gemini-3.7-flash': Object.freeze({ mode: 1, think: 4 }),
    'gemini-3.5-flash': Object.freeze({ mode: 1, think: 4 }),
    'gemini-3.5-flash-thinking': Object.freeze({ mode: 2, think: 0 }),
    'gemini-3.1-pro': Object.freeze({ mode: 3, think: 4 }),
    'gemini-3.1-pro-enhanced': Object.freeze({ mode: 3, think: 4, extra: { 31: 2, 80: 3 } }),
    'gemini-auto': Object.freeze({ mode: 4, think: 4 }),
    'gemini-3.5-flash-thinking-lite': Object.freeze({ mode: 5, think: 0 }),
    'gemini-flash-lite': Object.freeze({ mode: 6, think: 4 }),
});

// Keep the public model catalogue next to the protocol mapping so API clients
// can discover the exact model aliases accepted by the anonymous provider.
export const NOAUTH_MODEL_NAMES = Object.freeze(Object.keys(MODELS));

const FALLBACK_BL = 'boq_assistant-bard-web-server_20260716.08_p0';
const BL_PATTERN = /(boq_assistant-bard-web-server_\d+\.\d+_p\d+)/;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const UPLOAD_ENDPOINT = 'https://push.clients6.google.com/upload/';
const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;

let cachedBl = '';
let cachedUploadTokens = null;

function resolveModel(modelName) {
    let name = String(modelName || '').trim() || DEFAULT_NOAUTH_MODEL;
    let thinkOverride = null;
    const thinkIdx = name.indexOf('@think=');
    if (thinkIdx !== -1) {
        const suffix = name.slice(thinkIdx + '@think='.length);
        name = name.slice(0, thinkIdx);
        const parsed = Number.parseInt(suffix, 10);
        if (Number.isFinite(parsed)) thinkOverride = parsed;
    }
    const cfg = MODELS[name];
    if (!cfg) {
        const fallback = MODELS[DEFAULT_NOAUTH_MODEL];
        debugLog(
            `[No-Auth Gemini] Unknown model '${name}', falling back to '${DEFAULT_NOAUTH_MODEL}'`
        );
        return {
            ...fallback,
            modelId: fallback.mode,
            thinkMode: thinkOverride ?? fallback.think,
        };
    }
    return { ...cfg, modelId: cfg.mode, thinkMode: thinkOverride ?? cfg.think };
}

async function fetchLatestBl() {
    try {
        const response = await fetch('https://gemini.google.com/app', {
            headers: { 'User-Agent': USER_AGENT },
            credentials: 'omit',
        });
        if (!response.ok) return null;
        const html = await response.text();
        const match = html.match(BL_PATTERN);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

async function getBl(forceRefresh = false) {
    if (!cachedBl || forceRefresh) {
        const latest = await fetchLatestBl();
        if (latest) cachedBl = latest;
    }
    return cachedBl || FALLBACK_BL;
}

function extractPageToken(html, key) {
    const match = String(html || '').match(new RegExp(`"${key}":"([^"]+)`));
    return match ? match[1] : '';
}

async function fetchUploadTokens(forceRefresh = false) {
    if (
        !forceRefresh &&
        cachedUploadTokens &&
        cachedUploadTokens.expiresAt > Date.now() &&
        cachedUploadTokens.pushId &&
        cachedUploadTokens.clientPctx
    ) {
        return cachedUploadTokens;
    }

    const response = await fetch('https://gemini.google.com/app', {
        headers: { 'User-Agent': USER_AGENT },
        credentials: 'omit',
    });
    if (!response.ok) {
        throw new Error(`Gemini upload token fetch failed: HTTP ${response.status}`);
    }

    const html = await response.text();
    const pushId = extractPageToken(html, 'qKIAYe');
    const clientPctx = extractPageToken(html, 'Ylro7b');
    if (!pushId || !clientPctx) {
        throw new Error('Gemini upload tokens are unavailable on the anonymous page.');
    }

    cachedUploadTokens = {
        pushId,
        clientPctx,
        expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS,
    };
    return cachedUploadTokens;
}

function readHeader(response, name) {
    return response?.headers?.get?.(name) || response?.headers?.get?.(name.toLowerCase()) || '';
}

function decodeDataUrl(value) {
    const match = String(value || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
    if (!match) return null;

    const mimeType = match[1] || 'application/octet-stream';
    try {
        const bytes = match[2]
            ? Buffer.from(match[3].replace(/\s+/g, ''), 'base64')
            : Buffer.from(decodeURIComponent(match[3]), 'utf8');
        if (bytes.length === 0) return null;
        return { bytes, mimeType };
    } catch {
        return null;
    }
}

async function readMediaSource(media, signal) {
    if (media?.data) {
        const decoded = decodeDataUrl(media.data);
        if (!decoded) throw new Error('Invalid media data URL.');
        return { ...decoded, name: media.name || 'upload' };
    }

    const uri = media?.uri || media?.url;
    if (typeof uri !== 'string' || !uri) throw new Error('Media part is missing data or fileUri.');
    if (uri.startsWith('/contrib_service/')) return { fileRef: uri };

    let parsed;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error('fileUri must be an https:// or http:// URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('fileUri must use http:// or https://.');
    }

    const response = await fetch(parsed, {
        headers: { 'User-Agent': USER_AGENT },
        signal,
        credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('Media download returned an empty file.');
    return {
        bytes,
        mimeType:
            media.mimeType || readHeader(response, 'content-type') || 'application/octet-stream',
        name: media.name || parsed.pathname.split('/').pop() || 'download',
    };
}

async function uploadFileReference(file, signal) {
    if (file.fileRef) return file.fileRef;

    let tokens;
    try {
        tokens = await fetchUploadTokens();
    } catch (error) {
        cachedUploadTokens = null;
        tokens = await fetchUploadTokens(true).catch(() => {
            throw error;
        });
    }

    const startResponse = await fetch(UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            'Push-ID': tokens.pushId,
            'X-Tenant-Id': 'bard-storage',
            'X-Client-Pctx': tokens.clientPctx,
            'X-Goog-Upload-Header-Content-Length': String(file.bytes.length),
            'X-Goog-Upload-Header-Content-Type': file.mimeType,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'User-Agent': USER_AGENT,
        },
        body: `File name: ${file.name || 'upload'}`,
        signal,
        credentials: 'omit',
    });
    if (!startResponse.ok) {
        throw new Error(`Media upload start failed: HTTP ${startResponse.status}`);
    }
    const uploadUrl = readHeader(startResponse, 'x-goog-upload-url');
    if (!uploadUrl) throw new Error('Media upload start returned no upload URL.');

    const finalizeResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
            'Content-Type': file.mimeType,
            'User-Agent': USER_AGENT,
        },
        body: file.bytes,
        signal,
        credentials: 'omit',
    });
    if (!finalizeResponse.ok) {
        throw new Error(`Media upload failed: HTTP ${finalizeResponse.status}`);
    }
    const fileRef = (await finalizeResponse.text()).trim();
    if (!fileRef.startsWith('/'))
        throw new Error('Media upload returned an invalid file reference.');
    return fileRef;
}

/** Upload Gemini inlineData/fileData parts and return StreamGenerate refs. */
export async function uploadMediaParts(mediaParts, signal) {
    if (!Array.isArray(mediaParts) || mediaParts.length === 0) return [];
    const refs = [];
    for (const media of mediaParts) {
        const file = await readMediaSource(media, signal);
        refs.push(await uploadFileReference(file, signal));
    }
    return refs;
}

function buildPayload(prompt, modelId, thinkMode, fileRefs, extraFields) {
    const inner = new Array(102).fill(null);
    if (fileRefs && fileRefs.length > 0) {
        inner[0] = [prompt, 0, null, fileRefs.map((ref) => [null, null, ref]), null, null, 0];
    } else {
        inner[0] = [prompt, 0, null, null, null, null, 0];
    }
    inner[1] = ['en'];
    inner[2] = ['', '', '', null, null, null, null, null, null, ''];
    inner[6] = [0];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[thinkMode]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    inner[41] = [2]; // persist to account history (web2api temporary_chats=false)
    inner[53] = 0;
    inner[59] = crypto.randomUUID();
    inner[61] = [];
    inner[68] = 1;
    inner[79] = modelId;
    if (extraFields) {
        for (const [key, value] of Object.entries(extraFields)) inner[key] = value;
    }
    const outer = [null, JSON.stringify(inner)];
    return new URLSearchParams({ 'f.req': JSON.stringify(outer) });
}

function cleanText(text, strip = true) {
    let cleaned = String(text || '').replace(
        /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs,
        ''
    );
    cleaned = cleaned.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, '');
    return strip ? cleaned.trim() : cleaned;
}

function extractTextsFromLine(line) {
    if (!line.includes('"wrb.fr"') || line.length < 200) return [];
    try {
        const arr = JSON.parse(line);
        const innerStr = arr?.[0]?.[2];
        if (!innerStr || innerStr.length < 50) return [];
        const inner = JSON.parse(innerStr);
        if (!Array.isArray(inner) || inner.length <= 4 || !inner[4]) return [];
        const texts = [];
        for (const part of inner[4]) {
            if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
                for (const t of part[1]) {
                    if (typeof t === 'string' && t) texts.push(t);
                }
            }
        }
        return texts;
    } catch {
        return [];
    }
}

function buildEndpoint(bl) {
    const params = new URLSearchParams({
        bl,
        hl: 'en',
        _reqid: String(Date.now() % 1000000),
        rt: 'c',
    });
    return `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params.toString()}`;
}

function buildHeaders() {
    return {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://gemini.google.com',
        Referer: 'https://gemini.google.com/app',
        'X-Same-Domain': '1',
        'User-Agent': USER_AGENT,
    };
}

export function resolveNoAuthModel(modelName) {
    return resolveModel(modelName);
}

/**
 * Sends a single message through the anonymous StreamGenerate protocol.
 * Returns { text } or { text, truncated: true, error } on mid-stream failure.
 */
export async function sendNoAuthGeminiMessage(
    prompt,
    model,
    files,
    signal,
    onUpdate,
    options = {}
) {
    const { modelId, thinkMode, extra } = resolveModel(model);
    const body = buildPayload(prompt, modelId, thinkMode, options.fileRefs || null, extra);

    // One retry after refreshing bl on upstream rejection (405 / BardErrorInfo),
    // matching gemini-web2api's auto-update behaviour.
    for (let attempt = 0; attempt < 2; attempt++) {
        const bl = await getBl(attempt === 1);
        debugLog(`[No-Auth Gemini] POST StreamGenerate (${bl}, attempt ${attempt + 1})`);

        let response;
        try {
            response = await fetch(buildEndpoint(bl), {
                method: 'POST',
                signal,
                headers: buildHeaders(),
                credentials: 'omit',
                body,
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new Error(`Failed to fetch Gemini upstream: ${error.message || error}`);
        }

        if (response.status === 405) {
            if (attempt === 0) continue;
            throw new Error('Gemini upstream rejected request: HTTP 405');
        }
        if (!response.ok) {
            throw new Error(`Network Error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let emittedRawText = '';
        let streamError = null;

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                if (buffer.includes('BardErrorInfo')) {
                    const m = buffer.match(/BardErrorInfo[^\d]{0,24}\[(\d+)\]/);
                    throw new Error(
                        `Gemini upstream rejected request: BardErrorInfo${m ? ` [${m[1]}]` : ''}`
                    );
                }

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    for (const t of extractTextsFromLine(line)) {
                        if (t === emittedRawText || emittedRawText.startsWith(t)) continue;
                        if (!t.startsWith(emittedRawText)) {
                            throw new Error('Gemini stream content changed during retry');
                        }
                        emittedRawText = t;
                        if (onUpdate) onUpdate(cleanText(emittedRawText), undefined);
                    }
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            if (attempt === 0 && /BardErrorInfo/.test(error.message)) {
                continue; // refresh bl and retry
            }
            streamError = error; // includes upstream rejection on final attempt
        }

        // Tail: a final line may end without a trailing newline.
        if (buffer.length > 0) {
            for (const t of extractTextsFromLine(buffer)) {
                if (t.startsWith(emittedRawText) && t !== emittedRawText) {
                    emittedRawText = t;
                    if (onUpdate) onUpdate(cleanText(emittedRawText), undefined);
                }
            }
        }

        if (!emittedRawText) {
            if (/BardErrorInfo/.test(String(streamError?.message || ''))) {
                throw streamError;
            }
            const hint = buffer.includes('Sign in') ? ' (session required?)' : '';
            throw new Error(
                `No valid response found. Check network.${hint}${
                    streamError ? ` (stream error: ${streamError.message || streamError})` : ''
                }`
            );
        }

        if (streamError) {
            return { text: cleanText(emittedRawText), truncated: true, error: streamError };
        }

        return { text: cleanText(emittedRawText) };
    }

    throw new Error('Gemini upstream rejected request (retry exhausted).');
}
