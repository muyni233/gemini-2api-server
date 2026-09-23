export class UpstreamError extends Error {
    constructor(message, { status = 502, code, refreshBuild = false, retryAfter } = {}) {
        super(message);
        this.name = 'UpstreamError';
        this.status = status;
        this.code = code;
        this.refreshBuild = refreshBuild;
        this.retryAfter = retryAfter;
    }
}

function rpcError(code) {
    const descriptions = {
        1013: 'temporary upstream failure',
        1037: 'upstream usage limit exceeded',
        1050: 'model and conversation do not match',
        1052: 'model or request protocol is unavailable',
        1060: 'upstream temporarily blocked this network',
    };
    return new UpstreamError(
        `Gemini BardErrorInfo [${code}]: ${descriptions[code] || 'request rejected'}.`,
        {
            code,
            status: code === 1037 ? 429 : [1013, 1060].includes(code) ? 503 : 502,
            refreshBuild: code === 1052,
        }
    );
}

/** Decode every RPC envelope on a line, including short and batched responses. */
function parseLine(line) {
    const source = line.trim();
    if (!source || source === ")]}'" || /^\d+$/.test(source)) return [];
    let rows;
    try {
        rows = JSON.parse(source);
    } catch {
        throw new UpstreamError('Gemini returned a malformed RPC frame.');
    }
    if (!Array.isArray(rows)) throw new UpstreamError('Gemini returned an invalid RPC envelope.');
    const events = [];
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        // Inspect error metadata, never model-generated text containing "BardErrorInfo".
        const code = row[5]?.[2]?.[0]?.[1]?.[0];
        if (Number.isInteger(code) && code > 0) {
            events.push({ error: rpcError(code) });
            continue;
        }
        if (row[0] !== 'wrb.fr' || row[2] == null || row[2] === '') continue;
        let inner;
        try {
            inner = JSON.parse(row[2]);
        } catch {
            throw new UpstreamError('Gemini returned malformed candidate JSON.');
        }
        if (Array.isArray(inner?.[4])) events.push({ candidates: inner[4] });
    }
    return events;
}

/** Decode NDJSON and length-prefixed frames; Google lengths count UTF-16 units. */
export class RpcStreamDecoder {
    constructor(maxFrameChars = 4 * 1024 * 1024) {
        this.decoder = new TextDecoder('utf-8', { fatal: true });
        this.buffer = '';
        this.scanOffset = 0;
        this.expectedLength = null;
        this.prefixChecked = false;
        this.maxFrameChars = maxFrameChars;
    }
    push(bytes, final = false) {
        this.buffer += this.decoder.decode(bytes, { stream: !final });
        const events = [];
        const prefix = ")]}'";
        if (!this.prefixChecked) {
            if (!final && this.buffer.length < prefix.length && prefix.startsWith(this.buffer))
                return events;
            if (this.buffer.startsWith(prefix)) this.buffer = this.buffer.slice(prefix.length);
            this.prefixChecked = true;
        }
        for (;;) {
            if (this.expectedLength !== null) {
                if (this.buffer.length < this.expectedLength) break;
                events.push(...parseLine(this.buffer.slice(0, this.expectedLength)));
                this.buffer = this.buffer.slice(this.expectedLength);
                this.expectedLength = null;
                this.scanOffset = 0;
                continue;
            }
            const whitespace = /^\s+/.exec(this.buffer)?.[0].length || 0;
            if (whitespace) {
                this.buffer = this.buffer.slice(whitespace);
                this.scanOffset = Math.max(0, this.scanOffset - whitespace);
            }
            if (!this.buffer) break;
            if (/^[0-9]/.test(this.buffer)) {
                const marker = /^\d+/.exec(this.buffer)[0];
                if (marker.length === this.buffer.length && !final && marker.length <= 10) break;
                const size = Number(marker);
                if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxFrameChars) {
                    throw new UpstreamError(
                        'Gemini RPC frame is too large or its length is invalid.'
                    );
                }
                this.expectedLength = size;
                this.buffer = this.buffer.slice(marker.length);
                this.scanOffset = 0;
                continue;
            }
            const end = this.buffer.indexOf('\n', this.scanOffset);
            if (end === -1) {
                if (this.buffer.length > this.maxFrameChars)
                    throw new UpstreamError('Gemini RPC frame is too large.');
                this.scanOffset = this.buffer.length;
                if (final) {
                    events.push(...parseLine(this.buffer));
                    this.buffer = '';
                }
                break;
            }
            if (end > this.maxFrameChars) throw new UpstreamError('Gemini RPC frame is too large.');
            events.push(...parseLine(this.buffer.slice(0, end)));
            this.buffer = this.buffer.slice(end + 1);
            this.scanOffset = 0;
        }
        if (final && this.expectedLength !== null)
            throw new UpstreamError('Gemini stream ended inside a length-prefixed frame.');
        return events;
    }
}

const CODE_PREFIXES = ['python', 'javascript', 'text'].flatMap((language) =>
    ['reference', 'stdout'].map((kind) => `\`\`\`${language}?code_${kind}&code_event_index=`)
);
const CARD_PREFIX = 'http://googleusercontent.com/card_content/';
const ARTIFACT_PREFIXES = [...CODE_PREFIXES, CARD_PREFIX];

/** Withhold incomplete artifact markers so cleaning cannot retract emitted text. */
export function cleanSnapshot(text, final = false) {
    let source = text;
    if (!final) {
        let hold = 0;
        for (const prefix of ARTIFACT_PREFIXES) {
            for (let size = 1; size <= prefix.length && size <= source.length; size++) {
                if (source.endsWith(prefix.slice(0, size))) hold = Math.max(hold, size);
            }
        }
        if (hold) source = source.slice(0, -hold);
    }
    for (const prefix of CODE_PREFIXES) {
        let start;
        while ((start = source.indexOf(prefix)) !== -1) {
            const headerEnd = source.indexOf('\n', start + prefix.length);
            const close = headerEnd === -1 ? -1 : source.indexOf('```', headerEnd + 1);
            if (close === -1) {
                source = source.slice(0, start);
                break;
            }
            let end = close + 3;
            if (source[end] === '\r') end++;
            if (source[end] === '\n') end++;
            source = source.slice(0, start) + source.slice(end);
        }
    }
    return source.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, '');
}
