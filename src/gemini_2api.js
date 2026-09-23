import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createDeadline, positiveInteger, withAbort } from './async_utils.js';
import { createSseWriter } from './sse.js';
import { normalizeRequestOptions, recordAdjustment } from './request_options.js';
import {
    DEFAULT_NOAUTH_MODEL,
    NOAUTH_MODEL_NAMES,
    createNoAuthGeminiProvider,
    resolveNoAuthModel,
    UpstreamError,
} from './noauth_provider.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MODEL_VERSION = 'gemini-web-unverified';

const API_VERSION_PREFIXES = new Set(['', 'v1', 'v1beta']);
const GENERATE_METHODS = new Set(['generateContent', 'streamGenerateContent']);
const ROLE_NAMES = new Set(['user', 'model', 'assistant']);
const MODEL_DESCRIPTION = Object.freeze({
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
});

/**
 * HTTP error with the shape used by the Gemini REST API.
 */
export class GeminiApiError extends Error {
    constructor(status, message, options = {}) {
        super(message);
        this.name = 'GeminiApiError';
        this.status = status;
        this.statusText = options.statusText || statusToStatusText(status);
        this.code = options.code || this.statusText;
        this.param = options.param;
        this.retryAfter = options.retryAfter;
    }
}

function statusToStatusText(status) {
    if (status === 400) return 'INVALID_ARGUMENT';
    if (status === 401) return 'UNAUTHENTICATED';
    if (status === 403) return 'PERMISSION_DENIED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 413) return 'RESOURCE_EXHAUSTED';
    if (status === 429) return 'RESOURCE_EXHAUSTED';
    if (status === 499) return 'CANCELLED';
    if (status === 502) return 'BAD_GATEWAY';
    if (status === 503) return 'UNAVAILABLE';
    if (status === 504) return 'DEADLINE_EXCEEDED';
    return 'INTERNAL';
}

function getErrorStatus(error) {
    return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
}

function getErrorMessage(error) {
    if (error instanceof GeminiApiError) return error.message;
    return error?.message ? String(error.message) : 'Internal server error.';
}

function getErrorStatusText(error) {
    return error instanceof GeminiApiError
        ? error.statusText
        : statusToStatusText(getErrorStatus(error));
}

function createErrorBody(error) {
    return {
        error: {
            code: getErrorStatus(error),
            message: getErrorMessage(error),
            status: getErrorStatusText(error),
            ...(error?.param
                ? {
                      details: [
                          {
                              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                              param: error.param,
                          },
                      ],
                  }
                : {}),
        },
    };
}

function setCorsHeaders(request, response, options) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    const origin = request.headers.origin;
    if (origin) {
        let allowed =
            options.allowedOrigins?.includes('*') || options.allowedOrigins?.includes(origin);
        if (options.allowedOrigins === undefined) {
            try {
                const url = new URL(origin);
                allowed =
                    ['http:', 'https:'].includes(url.protocol) &&
                    url.origin === origin &&
                    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
            } catch {
                allowed = false;
            }
        }
        if (!allowed) throw new GeminiApiError(403, 'Browser origin is not allowed.');
        response.setHeader(
            'Access-Control-Allow-Origin',
            options.allowedOrigins?.includes('*') ? '*' : origin
        );
    }
    response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Goog-Api-Key, X-Api-Key, X-Goog-Api-Client'
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Type, Retry-After, X-Gemini-Token-Count, X-Gemini-Thinking-Mode, X-Gemini-Adjusted-Parameters'
    );
}

function writeJson(response, status, value) {
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify(value);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(body);
}

function writeError(response, error) {
    if (error?.retryAfter && /^[\w ,:\-]+$/.test(String(error.retryAfter))) {
        response.setHeader('Retry-After', String(error.retryAfter).slice(0, 128));
    }
    if (getErrorStatus(error) === 413) response.setHeader('Connection', 'close');
    writeJson(response, getErrorStatus(error), createErrorBody(error));
}

function endSse(response) {
    if (!response.writableEnded && !response.destroyed) {
        response.end();
    }
}

function normalizePath(pathname) {
    if (!pathname || pathname === '/') return '/';
    const withoutTrailingSlash = pathname.replace(/\/+$/, '');
    return withoutTrailingSlash || '/';
}

function decodePathPart(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new GeminiApiError(400, 'Request path contains invalid URL encoding.');
    }
}

function parseModelPath(pathname) {
    const parts = normalizePath(pathname).split('/').filter(Boolean);
    if (API_VERSION_PREFIXES.has(parts[0])) parts.shift();

    if (parts[0] !== 'models' || !parts[1] || parts.length !== 2) return null;
    const modelAndMethod = parts.slice(1).join('/');
    const methodIndex = modelAndMethod.lastIndexOf(':');
    if (methodIndex === -1) {
        return { model: decodePathPart(modelAndMethod), method: null };
    }

    return {
        model: decodePathPart(modelAndMethod.slice(0, methodIndex)),
        method: modelAndMethod.slice(methodIndex + 1),
    };
}

function getModelNames() {
    return Array.isArray(NOAUTH_MODEL_NAMES) && NOAUTH_MODEL_NAMES.length > 0
        ? NOAUTH_MODEL_NAMES
        : [DEFAULT_NOAUTH_MODEL];
}

function normalizeModelId(model) {
    let value = String(model || '').trim();
    if (value.startsWith('models/')) value = value.slice('models/'.length);
    if (!value) value = DEFAULT_NOAUTH_MODEL;
    return value;
}

function modelResource(model) {
    const id = normalizeModelId(model);
    return {
        name: `models/${id}`,
        baseModelId: id.split('@')[0],
        version: 'web-noauth',
        displayName: id,
        description:
            'Anonymous Gemini Web mode alias; backend version is unverified. Pro aliases may fall back to Flash. Token counts are estimates.',
        ...MODEL_DESCRIPTION,
    };
}

function listModelsResponse() {
    return { models: getModelNames().map(modelResource) };
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTextPart(part) {
    if (typeof part === 'string') return part;
    if (!isObject(part)) {
        throw new GeminiApiError(400, 'Each content part must be an object or text string.', {
            param: 'contents.parts',
        });
    }

    const variants = [
        'text',
        'inlineData',
        'inline_data',
        'fileData',
        'file_data',
        'functionCall',
        'function_call',
        'functionResponse',
        'function_response',
        'executableCode',
        'executable_code',
        'codeExecutionResult',
        'code_execution_result',
    ];
    if (variants.filter((key) => Object.hasOwn(part, key)).length !== 1) {
        throw new GeminiApiError(400, 'Each content part must contain exactly one data variant.', {
            param: 'contents.parts',
        });
    }
    if (typeof part.text === 'string') return part.text;

    if (part.inlineData || part.inline_data) {
        throw new GeminiApiError(
            400,
            'This no-auth server supports text only. Use the official Gemini API or a separate cookie-authenticated Web bridge for media.',
            { param: 'contents.parts.inlineData' }
        );
    }

    if (part.fileData || part.file_data) {
        throw new GeminiApiError(
            400,
            'This no-auth server supports text only. Use the official Gemini API or a separate cookie-authenticated Web bridge for media.',
            { param: 'contents.parts.fileData' }
        );
    }

    if (part.functionCall || part.function_call) {
        const call = part.functionCall || part.function_call;
        if (
            !isObject(call) ||
            typeof call.name !== 'string' ||
            !call.name.trim() ||
            (call.args !== undefined && !isObject(call.args))
        ) {
            throw new GeminiApiError(400, 'functionCall must contain a function name.', {
                param: 'contents.parts.functionCall',
            });
        }
        return `<function_call>${JSON.stringify({ name: call.name, args: call.args ?? {}, ...(call.id ? { id: call.id } : {}) })}</function_call>`;
    }

    if (part.functionResponse || part.function_response) {
        const response = part.functionResponse || part.function_response;
        if (
            !isObject(response) ||
            typeof response.name !== 'string' ||
            !response.name.trim() ||
            (response.response !== undefined && !isObject(response.response))
        ) {
            throw new GeminiApiError(400, 'functionResponse must contain a function name.', {
                param: 'contents.parts.functionResponse',
            });
        }
        const id =
            typeof response.id === 'string' && response.id ? ` (call id: ${response.id})` : '';
        return `Tool response for ${response.name}${id}: ${JSON.stringify(response.response ?? {})}`;
    }

    if (part.executableCode || part.executable_code) {
        const executable = part.executableCode || part.executable_code;
        return `Executable code result: ${JSON.stringify(executable)}`;
    }

    if (part.codeExecutionResult || part.code_execution_result) {
        const result = part.codeExecutionResult || part.code_execution_result;
        return `Code execution result: ${JSON.stringify(result)}`;
    }

    throw new GeminiApiError(400, 'Each content part must contain text.', {
        param: 'contents.parts',
    });
}

function readParts(parts, param = 'contents.parts') {
    if (!Array.isArray(parts) || parts.length === 0) {
        throw new GeminiApiError(400, 'Each content must contain at least one part.', { param });
    }
    return parts
        .map((part) => readTextPart(part))
        .filter((text) => text.length > 0)
        .join('\n');
}

function normalizeContent(content, index) {
    if (!isObject(content)) {
        throw new GeminiApiError(400, 'Each contents item must be an object.', {
            param: `contents[${index}]`,
        });
    }
    const role = content.role === 'assistant' ? 'model' : content.role || 'user';
    if (!ROLE_NAMES.has(role)) {
        throw new GeminiApiError(400, `Unsupported content role: ${role}.`, {
            param: `contents[${index}].role`,
        });
    }
    const text = readParts(content.parts, `contents[${index}].parts`);
    return { role: role === 'assistant' ? 'model' : role, text };
}

function readSystemInstruction(systemInstruction) {
    if (systemInstruction == null) return '';
    if (typeof systemInstruction === 'string') return systemInstruction.trim();
    if (!isObject(systemInstruction)) {
        throw new GeminiApiError(400, 'systemInstruction must be an object with parts.', {
            param: 'systemInstruction',
        });
    }
    return readParts(systemInstruction.parts, 'systemInstruction.parts').trim();
}

function formatToolPrompt(declarations, toolMode) {
    if (declarations.length === 0 || toolMode.mode === 'NONE') return '';

    const available = declarations
        .filter(
            (declaration) =>
                toolMode.allowedFunctionNames.length === 0 ||
                toolMode.allowedFunctionNames.includes(declaration.name)
        )
        .map((declaration) =>
            JSON.stringify({
                name: declaration.name,
                description: declaration.description,
                parameters: declaration.parameters,
            })
        )
        .join('\n');

    const modeInstruction =
        toolMode.mode === 'ANY'
            ? 'You must call one of the available tools when answering.'
            : 'Call a tool only when it is useful for answering the user.';

    return [
        'Tool calling is available for this request.',
        modeInstruction,
        'Available function declarations (one JSON object per line):',
        available,
        'When you need a tool, output exactly one marker in this form and nothing else around it:',
        '<function_call>{"name":"function_name","args":{"argument":"value"}}</function_call>',
        'The args value must be a JSON object matching the function parameters. Do not use Markdown fences for a function call.',
        'After a tool response is provided, use it to answer the user normally or call another available tool.',
    ].join('\n');
}

function formatConversation(contents) {
    return contents
        .map((content) => `${content.role === 'model' ? 'Model' : 'User'}: ${content.text}`)
        .join('\n\n');
}

function buildPrompt(request, adjustments = []) {
    const { thinking, declarations, toolMode } = normalizeRequestOptions(request, adjustments);
    const contents = request.contents.map(normalizeContent);
    if (contents.length === 0) {
        throw new GeminiApiError(400, 'contents must contain at least one item.', {
            param: 'contents',
        });
    }

    const system = readSystemInstruction(request.systemInstruction ?? request.system_instruction);
    if (!contents.some((content) => content.text.trim())) {
        throw new GeminiApiError(
            400,
            'contents must contain non-empty text or a function exchange.'
        );
    }
    const sections = [];

    if (system) sections.push(`System instruction:\n${system}`);

    const toolPrompt = formatToolPrompt(declarations, toolMode);
    if (toolPrompt) sections.push(toolPrompt);

    if (contents.length > 1) {
        sections.push(
            'Conversation history:\n(Previous messages are context. Continue the conversation from the final message.)\n' +
                formatConversation(contents.slice(0, -1))
        );
    }

    sections.push(
        `Current message (${contents.at(-1).role === 'model' ? 'model' : 'user'}):\n${contents.at(-1).text}`
    );

    return {
        prompt: sections.join('\n\n'),
        declarations,
        toolMode,
        contents,
        thinking,
        adjustments,
    };
}

function applyThinking(model, thinking, adjustments) {
    if (!thinking) return model;
    const config = resolveNoAuthModel(model);
    if (model.includes('@think=') && config.think !== thinking.mode)
        recordAdjustment(adjustments, 'model.@think');
    return config.name + '@think=' + thinking.mode;
}

function setOptionHeaders(response, adjustments, model) {
    response.setHeader('X-Gemini-Thinking-Mode', String(resolveNoAuthModel(model).think));
    const fields = [];
    let size = 0;
    for (const field of adjustments) {
        const encoded = encodeURIComponent(field);
        if (size + encoded.length > 1800) {
            fields.push('...');
            break;
        }
        fields.push(encoded);
        size += encoded.length + 2;
    }
    if (fields.length) response.setHeader('X-Gemini-Adjusted-Parameters', fields.join(', '));
}

function parseJsonObject(value) {
    try {
        const parsed = JSON.parse(value);
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeFunctionCall(candidate, declarations, toolMode) {
    if (!isObject(candidate)) return null;
    const nested = isObject(candidate.function) ? candidate.function : candidate;
    const name = typeof nested.name === 'string' ? nested.name.trim() : '';
    if (!name) return null;
    if (toolMode.allowedFunctionNames.length > 0 && !toolMode.allowedFunctionNames.includes(name)) {
        return null;
    }
    if (!declarations.some((declaration) => declaration.name === name)) return null;

    let args = nested.args ?? nested.arguments ?? nested.parameters ?? {};
    if (typeof args === 'string') {
        const parsedArgs = parseJsonObject(args);
        if (!parsedArgs) return null;
        args = parsedArgs;
    }
    if (!isObject(args)) return null;
    return { ...(typeof nested.id === 'string' && nested.id ? { id: nested.id } : {}), name, args };
}

function parseFunctionCalls(text, declarations, toolMode) {
    if (declarations.length === 0 || toolMode.mode === 'NONE') return null;
    let remaining = String(text || '').trim();
    if (!remaining) return null;
    const calls = [];
    // Consume only complete, standalone call documents. Searching arbitrary prose
    // would execute quoted examples and repeatedly scan malformed opening tags.
    if (/^<(function_call|tool_call)>/i.test(remaining)) {
        while (remaining) {
            const open = /^<(function_call|tool_call)>/i.exec(remaining);
            if (!open) return null;
            const closePattern =
                open[1].toLowerCase() === 'function_call' ? /<\/function_call>/i : /<\/tool_call>/i;
            const close = closePattern.exec(remaining.slice(open[0].length));
            if (!close) return null;
            const contentEnd = open[0].length + close.index;
            const call = normalizeFunctionCall(
                parseJsonObject(remaining.slice(open[0].length, contentEnd)),
                declarations,
                toolMode
            );
            if (!call) return null;
            calls.push(call);
            remaining = remaining.slice(contentEnd + close[0].length).trim();
        }
        return calls;
    }
    if (remaining.startsWith('```')) {
        while (remaining) {
            const open = /^```(?:json|function_call|tool_call)?\s*/i.exec(remaining);
            if (!open) return null;
            const end = remaining.indexOf('```', open[0].length);
            if (end === -1) return null;
            const call = normalizeFunctionCall(
                parseJsonObject(remaining.slice(open[0].length, end)),
                declarations,
                toolMode
            );
            if (!call) return null;
            calls.push(call);
            remaining = remaining.slice(end + 3).trim();
        }
        return calls;
    }
    const looseCall = /^function_call\s*\n([\s\S]+)$/.exec(remaining);
    const call = normalizeFunctionCall(
        parseJsonObject(looseCall ? looseCall[1] : remaining),
        declarations,
        toolMode
    );
    return call ? [call] : null;
}

function toResponseParts(text, toolContext) {
    const calls = parseFunctionCalls(text, toolContext.declarations, toolContext.toolMode);
    if (!calls && toolContext.toolMode.mode === 'ANY') {
        throw new GeminiApiError(
            502,
            'Gemini did not return a valid call to an allowed function in ANY mode.'
        );
    }
    if (!calls) return text ? [{ text }] : [];

    return calls.map((call) => ({
        functionCall: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            args: call.args,
        },
    }));
}

function estimateTokens(text) {
    let length = 0;
    for (const character of String(text || '')) length++;
    return Math.ceil(length / 4);
}

function createUsageMetadata(prompt, text) {
    const promptTokenCount = estimateTokens(prompt);
    const candidatesTokenCount = estimateTokens(text);
    return {
        promptTokenCount,
        candidatesTokenCount,
        totalTokenCount: promptTokenCount + candidatesTokenCount,
    };
}

function createCandidate(parts, options = {}) {
    return {
        content: { role: 'model', parts },
        finishReason: options.finishReason || 'STOP',
        index: 0,
    };
}

function createGenerateResponse(model, text, toolContext, prompt) {
    const parts = toResponseParts(text, toolContext);
    const response = {
        candidates: [createCandidate(parts)],
        modelVersion: MODEL_VERSION,
        usageMetadata: createUsageMetadata(prompt, text),
    };
    if (parts.length === 0) response.promptFeedback = { blockReason: 'OTHER' };
    return response;
}

function normalizeProviderResult(result) {
    if (typeof result === 'string') return { text: result };
    if (!isObject(result)) return { text: '' };
    return { ...result, text: typeof result.text === 'string' ? result.text : '' };
}

async function callProvider({ prompt, model, signal, onUpdate, sendMessage }) {
    let result;
    try {
        signal?.throwIfAborted();
        result = await withAbort(
            Promise.resolve().then(() => {
                signal?.throwIfAborted();
                return sendMessage(prompt, model, [], signal, onUpdate);
            }),
            signal
        );
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        if (error instanceof GeminiApiError) throw error;
        throw new GeminiApiError(
            error instanceof UpstreamError ? error.status : 502,
            `Gemini upstream request failed: ${getErrorMessage(error)}`,
            {
                retryAfter: error instanceof UpstreamError ? error.retryAfter : undefined,
            }
        );
    }
    const normalized = normalizeProviderResult(result);
    if (normalized.truncated) {
        throw new GeminiApiError(
            502,
            'Gemini upstream returned a truncated response. Please retry.',
            {
                statusText: 'BAD_GATEWAY',
            }
        );
    }
    if (!normalized.text.trim()) {
        throw new GeminiApiError(502, 'Gemini upstream returned no text response.', {
            statusText: 'BAD_GATEWAY',
        });
    }
    return normalized;
}

async function readRequestBody(request, maxBodyBytes, signal) {
    const encoding = request.headers['content-encoding'];
    if (encoding && encoding !== 'identity')
        throw new GeminiApiError(400, 'Compressed request bodies are not supported.');
    if (Number(request.headers['content-length']) > maxBodyBytes) {
        request.resume();
        throw new GeminiApiError(413, 'Request body exceeds ' + maxBodyBytes + ' bytes.');
    }
    return new Promise((resolve, reject) => {
        let size = 0;
        let chunks = [];
        const cleanup = () => {
            request.off('data', data);
            request.off('end', end);
            request.off('error', fail);
            signal.removeEventListener('abort', abort);
        };
        const fail = (error) => {
            cleanup();
            chunks = [];
            request.resume();
            reject(error);
        };
        const abort = () => fail(signal.reason);
        const data = (chunk) => {
            size += chunk.length;
            if (size > maxBodyBytes) {
                fail(new GeminiApiError(413, 'Request body exceeds ' + maxBodyBytes + ' bytes.'));
            } else chunks.push(chunk);
        };
        const end = () => {
            cleanup();
            try {
                const raw = new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(chunks, size)
                );
                chunks = [];
                const parsed = JSON.parse(raw);
                if (!isObject(parsed)) throw new Error('not an object');
                resolve(parsed);
            } catch {
                reject(
                    new GeminiApiError(400, 'Request body must contain a valid UTF-8 JSON object.')
                );
            }
        };
        request.on('data', data);
        request.once('end', end);
        request.once('error', fail);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}

function getRequestModel(model, adjustments = []) {
    let normalized = normalizeModelId(model);
    const suffixIndex = normalized.indexOf('@');
    if (suffixIndex !== -1) {
        const base = normalized.slice(0, suffixIndex);
        const suffix = normalized.slice(suffixIndex);
        const parsed = /^@think=(-?\d+)$/.exec(suffix);
        const value = parsed ? Number(parsed[1]) : NaN;
        normalized = Number.isSafeInteger(value)
            ? base + '@think=' + Math.min(4, Math.max(0, value))
            : base;
        if (normalized !== base + suffix) recordAdjustment(adjustments, 'model.@think');
    }
    try {
        resolveNoAuthModel(normalized);
    } catch (error) {
        throw new GeminiApiError(error.status || 400, error.message, { param: 'model' });
    }
    return normalized;
}

function requireContents(body) {
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
        throw new GeminiApiError(400, 'contents must be a non-empty array.', { param: 'contents' });
    }
}

async function handleGenerate(request, response, options, model, method) {
    const adjustments = [];
    const requestedModel = getRequestModel(model, adjustments);
    const body = await readRequestBody(request, options.maxBodyBytes, options.signal);
    requireContents(body);
    const context = buildPrompt(body, adjustments);
    const targetModel = applyThinking(requestedModel, context.thinking, adjustments);
    setOptionHeaders(response, adjustments, targetModel);
    if (options.state.active >= options.maxConcurrentRequests) {
        throw new GeminiApiError(429, 'Too many active generation requests.', { retryAfter: '1' });
    }
    options.signal.throwIfAborted();
    options.state.active++;
    const deadline = createDeadline(
        options.signal,
        options.requestTimeoutMs,
        new GeminiApiError(504, 'Generation request timed out.')
    );
    const signal = deadline.signal;
    let heartbeat;
    response.setHeader('X-Gemini-Token-Count', 'estimated');
    try {
        if (method !== 'streamGenerateContent') {
            const result = await callProvider({
                prompt: context.prompt,
                model: targetModel,
                signal,
                sendMessage: options.sendMessage,
            });
            writeJson(
                response,
                200,
                createGenerateResponse(targetModel, result.text, context, context.prompt)
            );
            return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');
        response.flushHeaders();
        const writer = createSseWriter(response, signal, options.maxPendingSseBytes);
        heartbeat = setInterval(() => {
            if (
                !signal.aborted &&
                !response.destroyed &&
                !response.writableEnded &&
                writer.isIdle() &&
                response.writableLength === 0
            )
                response.write(': keep-alive\n\n');
        }, 10_000);
        heartbeat.unref?.();
        const bufferTools = context.declarations.length > 0 && context.toolMode.mode !== 'NONE';
        let streamedText = '';
        const update = (next) => {
            signal.throwIfAborted();
            if (typeof next !== 'string')
                throw new GeminiApiError(502, 'Gemini returned an invalid text update.');
            if (!next.startsWith(streamedText))
                throw new GeminiApiError(502, 'Gemini revised text that was already streamed.');
            const delta = next.slice(streamedText.length);
            streamedText = next;
            if (!delta) return Promise.resolve();
            return writer.write({
                candidates: [{ content: { role: 'model', parts: [{ text: delta }] }, index: 0 }],
                modelVersion: MODEL_VERSION,
            });
        };
        try {
            const result = await callProvider({
                prompt: context.prompt,
                model: targetModel,
                signal,
                sendMessage: options.sendMessage,
                onUpdate: bufferTools ? undefined : update,
            });
            if (bufferTools) {
                await writer.write({
                    candidates: [createCandidate(toResponseParts(result.text, context))],
                    modelVersion: MODEL_VERSION,
                    usageMetadata: createUsageMetadata(context.prompt, result.text),
                });
            } else {
                await update(result.text);
                await writer.write({
                    candidates: [createCandidate([])],
                    modelVersion: MODEL_VERSION,
                    usageMetadata: createUsageMetadata(context.prompt, result.text),
                });
            }
            await writer.flush();
            endSse(response);
        } catch (error) {
            await writer.flush().catch(() => {});
            if (!options.signal.aborted && !response.destroyed && !response.writableEnded) {
                response.write('data: ' + JSON.stringify(createErrorBody(error)) + '\n\n');
            }
            endSse(response);
        }
    } finally {
        clearInterval(heartbeat);
        deadline.dispose();
        options.state.active--;
    }
}

async function handleCountTokens(request, response, options, model) {
    const adjustments = [];
    const targetModel = getRequestModel(model, adjustments);
    const body = await readRequestBody(request, options.maxBodyBytes, options.signal);
    let input = body;
    const nested = body.generateContentRequest ?? body.generate_content_request;
    if (nested !== undefined) {
        if (!isObject(nested)) recordAdjustment(adjustments, 'generateContentRequest');
        else {
            if (body.contents !== undefined) recordAdjustment(adjustments, 'contents');
            if (nested.model && normalizeModelId(nested.model) !== targetModel)
                recordAdjustment(adjustments, 'generateContentRequest.model');
            input = nested;
        }
    }
    requireContents(input);
    const context = buildPrompt(input, adjustments);
    const effectiveModel = applyThinking(targetModel, context.thinking, adjustments);
    setOptionHeaders(response, adjustments, effectiveModel);
    const totalTokens = estimateTokens(context.prompt);
    response.setHeader('X-Gemini-Token-Count', 'estimated');
    writeJson(response, 200, {
        totalTokens,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: totalTokens }],
    });
}

function authorize(request, url, options) {
    if (!options.apiKey) return;
    const authorization = request.headers.authorization || '';
    const supplied =
        (authorization.startsWith('Bearer ') ? authorization.slice(7) : '') ||
        request.headers['x-goog-api-key'] ||
        request.headers['x-api-key'] ||
        url.searchParams.get('key') ||
        '';
    const digest = (value) => createHash('sha256').update(String(value)).digest();
    if (!timingSafeEqual(digest(supplied), options.apiKeyHash))
        throw new GeminiApiError(401, 'Invalid or missing API key.');
}

async function routeRequest(request, response, options) {
    const url = new URL(request.url || '/', 'http://localhost');
    const pathname = normalizePath(url.pathname);

    if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
    }

    if (
        request.method === 'GET' &&
        (pathname === '/' || pathname === '/healthz' || pathname === '/health')
    ) {
        writeJson(response, 200, {
            status: 'ok',
            service: 'gemini-nexus-2api',
            auth: options.apiKey ? 'api-key' : 'none',
            protocol: 'gemini',
        });
        return;
    }

    authorize(request, url, options);

    if (
        request.method === 'GET' &&
        (pathname === '/models' || pathname === '/v1/models' || pathname === '/v1beta/models')
    ) {
        writeJson(response, 200, listModelsResponse());
        return;
    }

    const action = parseModelPath(pathname);
    if (!action) {
        throw new GeminiApiError(404, 'Route not found.');
    }

    if (request.method === 'GET' && action.method === null) {
        const adjustments = [];
        const model = getRequestModel(action.model, adjustments);
        setOptionHeaders(response, adjustments, model);
        writeJson(response, 200, modelResource(model));
        return;
    }

    if (request.method !== 'POST' || !action.method) {
        throw new GeminiApiError(404, 'Route not found.');
    }

    if (GENERATE_METHODS.has(action.method)) {
        await handleGenerate(request, response, options, action.model, action.method);
        return;
    }
    if (action.method === 'countTokens') {
        await handleCountTokens(request, response, options, action.model);
        return;
    }

    throw new GeminiApiError(404, `Unsupported model method: ${action.method}.`);
}

/**
 * Creates a Gemini-format HTTP server backed by the anonymous Gemini Web provider.
 * Local API-key protection is optional and independent of upstream authentication.
 */
export function createGemini2ApiServer(options = {}) {
    const resolvedOptions = {
        maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
        requestTimeoutMs: 180_000,
        maxConcurrentRequests: 8,
        maxPendingSseBytes: 1024 * 1024,
        ...options,
        state: { active: 0 },
    };
    for (const key of [
        'maxBodyBytes',
        'requestTimeoutMs',
        'maxConcurrentRequests',
        'maxPendingSseBytes',
    ]) {
        positiveInteger(resolvedOptions[key], key);
    }
    if (resolvedOptions.apiKey !== undefined && typeof resolvedOptions.apiKey !== 'string')
        throw new TypeError('apiKey must be a string.');
    if (resolvedOptions.apiKey)
        resolvedOptions.apiKeyHash = createHash('sha256').update(resolvedOptions.apiKey).digest();
    if (
        resolvedOptions.allowedOrigins !== undefined &&
        (!Array.isArray(resolvedOptions.allowedOrigins) ||
            resolvedOptions.allowedOrigins.some((origin) => {
                if (origin === '*') return false;
                try {
                    const url = new URL(origin);
                    return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
                } catch {
                    return true;
                }
            }))
    )
        throw new TypeError('allowedOrigins must contain exact HTTP(S) origins or *.');
    const ownedProvider =
        resolvedOptions.sendMessage == null
            ? createNoAuthGeminiProvider({ generationTimeoutMs: resolvedOptions.requestTimeoutMs })
            : null;
    resolvedOptions.sendMessage ??= ownedProvider;
    if (typeof resolvedOptions.sendMessage !== 'function')
        throw new TypeError('sendMessage must be a function.');
    const controllers = new Set();
    let stopping = false;
    const server = createServer(
        {
            requestTimeout: 30_000,
            headersTimeout: 10_000,
            keepAliveTimeout: 5_000,
            maxHeaderSize: 16_384,
        },
        async (request, response) => {
            const controller = new AbortController();
            controllers.add(controller);
            const abort = () =>
                controller.abort(new DOMException('Client disconnected', 'AbortError'));
            const close = () => {
                if (!response.writableEnded) abort();
            };
            request.once('aborted', abort);
            request.on('error', abort);
            response.once('close', close);
            response.on('error', abort);
            try {
                setCorsHeaders(request, response, resolvedOptions);
                if (stopping) throw new GeminiApiError(503, 'Server is shutting down.');
                // IncomingMessage.signal is read-only on newer Node releases.
                await routeRequest(request, response, {
                    ...resolvedOptions,
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted || response.writableEnded || response.destroyed)
                    return;
                if (response.headersSent) {
                    response.destroy();
                    return;
                }
                writeError(response, error);
            } finally {
                controllers.delete(controller);
                request.off('aborted', abort);
                response.off('close', close);
                if (!request.complete) request.resume();
            }
        }
    );
    server.once('close', () => ownedProvider?.close());
    let shutdownPromise;
    server.shutdown = ({ gracePeriodMs = 10_000 } = {}) => {
        positiveInteger(gracePeriodMs, 'gracePeriodMs');
        if (shutdownPromise) return shutdownPromise;
        stopping = true;
        shutdownPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                for (const controller of controllers)
                    controller.abort(new GeminiApiError(503, 'Server is shutting down.'));
                server.closeAllConnections();
            }, gracePeriodMs);
            timer.unref?.();
            server.close((error) => {
                clearTimeout(timer);
                error ? reject(error) : resolve();
            });
            server.closeIdleConnections();
        });
        return shutdownPromise;
    };
    return server;
}

export async function startGemini2ApiServer(options = {}) {
    const host = options.host || process.env.GEMINI_2API_HOST || DEFAULT_HOST;
    const configuredPort =
        options.port ?? process.env.GEMINI_2API_PORT ?? process.env.PORT ?? DEFAULT_PORT;
    const port = Number(configuredPort);
    if (
        !['number', 'string'].includes(typeof configuredPort) ||
        (typeof configuredPort === 'string' && !/^\d+$/.test(configuredPort)) ||
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65_535
    ) {
        throw new TypeError(`Invalid port: ${configuredPort}`);
    }

    const server = createGemini2ApiServer({
        apiKey: process.env.GEMINI_2API_API_KEY,
        ...(process.env.GEMINI_2API_ALLOWED_ORIGINS !== undefined
            ? {
                  allowedOrigins: process.env.GEMINI_2API_ALLOWED_ORIGINS.split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
              }
            : {}),
        ...(process.env.GEMINI_2API_TIMEOUT_MS !== undefined
            ? { requestTimeoutMs: Number(process.env.GEMINI_2API_TIMEOUT_MS) }
            : {}),
        ...(process.env.GEMINI_2API_MAX_CONCURRENT !== undefined
            ? { maxConcurrentRequests: Number(process.env.GEMINI_2API_MAX_CONCURRENT) }
            : {}),
        ...options,
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });

    const address = server.address();
    return {
        server,
        host,
        port: typeof address === 'object' && address ? address.port : port,
    };
}
