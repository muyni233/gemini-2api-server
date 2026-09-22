import { createServer } from 'node:http';
import {
    DEFAULT_NOAUTH_MODEL,
    NOAUTH_MODEL_NAMES,
    sendNoAuthGeminiMessage,
} from './noauth_provider.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

const API_VERSION_PREFIXES = new Set(['', 'v1', 'v1beta']);
const GENERATE_METHODS = new Set(['generateContent', 'streamGenerateContent']);
const ROLE_NAMES = new Set(['user', 'model', 'assistant']);

const MODEL_DESCRIPTION = Object.freeze({
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
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
    }
}

function statusToStatusText(status) {
    if (status === 400) return 'INVALID_ARGUMENT';
    if (status === 404) return 'NOT_FOUND';
    if (status === 413) return 'RESOURCE_EXHAUSTED';
    if (status === 499) return 'CANCELLED';
    if (status === 502) return 'BAD_GATEWAY';
    if (status === 503) return 'UNAVAILABLE';
    return 'INTERNAL';
}

function getErrorStatus(error) {
    return Number.isInteger(error?.status) ? error.status : 500;
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

function setCorsHeaders(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Goog-Api-Key'
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
}

function writeJson(response, status, value) {
    if (response.writableEnded) return;
    const body = JSON.stringify(value);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(body);
}

function writeError(response, error) {
    writeJson(response, getErrorStatus(error), createErrorBody(error));
}

function writeSse(response, value) {
    if (response.writableEnded || response.destroyed) return false;
    response.write(`data: ${JSON.stringify(value)}\n\n`);
    return true;
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

function parseModelPath(pathname) {
    const parts = normalizePath(pathname).split('/').filter(Boolean);
    if (API_VERSION_PREFIXES.has(parts[0])) parts.shift();

    if (parts[0] !== 'models' || !parts[1]) return null;
    const modelAndMethod = parts.slice(1).join('/');
    const methodIndex = modelAndMethod.lastIndexOf(':');
    if (methodIndex === -1) {
        return { model: decodeURIComponent(modelAndMethod), method: null };
    }

    return {
        model: decodeURIComponent(modelAndMethod.slice(0, methodIndex)),
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
        description: 'Gemini Nexus anonymous Gemini Web bridge',
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

    if (typeof part.text === 'string') return part.text;

    if (part.inlineData || part.inline_data || part.fileData || part.file_data) {
        throw new GeminiApiError(
            400,
            'The anonymous Gemini Web bridge does not support image or file input.',
            { param: 'contents.parts' }
        );
    }

    if (part.functionCall || part.function_call) {
        const call = part.functionCall || part.function_call;
        if (!isObject(call) || typeof call.name !== 'string') {
            throw new GeminiApiError(400, 'functionCall must contain a function name.', {
                param: 'contents.parts.functionCall',
            });
        }
        const id = typeof call.id === 'string' && call.id ? ` id="${call.id}"` : '';
        return `<function_call_result name="${call.name}"${id}>${JSON.stringify(call.args || {})}</function_call_result>`;
    }

    if (part.functionResponse || part.function_response) {
        const response = part.functionResponse || part.function_response;
        if (!isObject(response) || typeof response.name !== 'string') {
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

function getFunctionDeclarations(tools) {
    if (tools == null) return [];
    if (!Array.isArray(tools)) {
        throw new GeminiApiError(400, 'tools must be an array.', { param: 'tools' });
    }

    const declarations = [];
    tools.forEach((tool, toolIndex) => {
        if (!isObject(tool)) {
            throw new GeminiApiError(400, 'Each tool must be an object.', {
                param: `tools[${toolIndex}]`,
            });
        }
        const rawDeclarations = tool.functionDeclarations || tool.function_declarations;
        if (rawDeclarations == null) return;
        if (!Array.isArray(rawDeclarations)) {
            throw new GeminiApiError(400, 'functionDeclarations must be an array.', {
                param: `tools[${toolIndex}].functionDeclarations`,
            });
        }
        rawDeclarations.forEach((declaration, declarationIndex) => {
            if (
                !isObject(declaration) ||
                typeof declaration.name !== 'string' ||
                !declaration.name.trim()
            ) {
                throw new GeminiApiError(400, 'Every function declaration needs a name.', {
                    param: `tools[${toolIndex}].functionDeclarations[${declarationIndex}]`,
                });
            }
            declarations.push({
                name: declaration.name.trim(),
                description:
                    typeof declaration.description === 'string' ? declaration.description : '',
                parameters:
                    declaration.parametersJsonSchema ||
                    declaration.parameters_json_schema ||
                    declaration.parameters ||
                    {},
            });
        });
    });

    const seen = new Set();
    return declarations.filter((declaration) => {
        if (seen.has(declaration.name)) return false;
        seen.add(declaration.name);
        return true;
    });
}

function readToolMode(toolConfig) {
    const config = toolConfig?.functionCallingConfig || toolConfig?.function_calling_config;
    if (!config) return { mode: 'AUTO', allowedFunctionNames: [] };
    const mode = String(config.mode || 'AUTO').toUpperCase();
    if (!['AUTO', 'ANY', 'NONE'].includes(mode)) {
        throw new GeminiApiError(400, `Unsupported function calling mode: ${mode}.`, {
            param: 'toolConfig.functionCallingConfig.mode',
        });
    }
    const allowedFunctionNames = config.allowedFunctionNames || config.allowed_function_names || [];
    if (
        !Array.isArray(allowedFunctionNames) ||
        allowedFunctionNames.some((name) => typeof name !== 'string')
    ) {
        throw new GeminiApiError(400, 'allowedFunctionNames must be an array of strings.', {
            param: 'toolConfig.functionCallingConfig.allowedFunctionNames',
        });
    }
    return { mode, allowedFunctionNames };
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

function buildPrompt(request) {
    const contents = request.contents.map(normalizeContent);
    if (contents.length === 0) {
        throw new GeminiApiError(400, 'contents must contain at least one item.', {
            param: 'contents',
        });
    }

    const system = readSystemInstruction(request.systemInstruction || request.system_instruction);
    const declarations = getFunctionDeclarations(request.tools);
    const toolMode = readToolMode(request.toolConfig || request.tool_config);
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
    };
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
    const source = String(text || '').trim();
    if (!source) return null;

    const calls = [];
    const markerPattern =
        /<(?:function_call|tool_call)>\s*([\s\S]*?)\s*<\/(?:function_call|tool_call)>/gi;
    let match;
    while ((match = markerPattern.exec(source)) !== null) {
        const call = normalizeFunctionCall(parseJsonObject(match[1]), declarations, toolMode);
        if (!call) return null;
        calls.push(call);
    }
    if (calls.length > 0) return calls;

    const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
    while ((match = fencedPattern.exec(source)) !== null) {
        const call = normalizeFunctionCall(
            parseJsonObject(match[1].trim()),
            declarations,
            toolMode
        );
        if (call) calls.push(call);
    }
    if (calls.length > 0 && source.replace(fencedPattern, '').trim() === '') return calls;

    const rawCall = normalizeFunctionCall(parseJsonObject(source), declarations, toolMode);
    return rawCall ? [rawCall] : null;
}

function toResponseParts(text, toolContext) {
    const calls = parseFunctionCalls(text, toolContext.declarations, toolContext.toolMode);
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
    const length = Array.from(String(text || '')).length;
    return Math.max(1, Math.ceil(length / 4));
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
        modelVersion: normalizeModelId(model),
        usageMetadata: createUsageMetadata(prompt, text),
    };
    if (parts.length === 0) response.promptFeedback = { blockReason: 'OTHER' };
    return response;
}

function normalizeProviderResult(result) {
    if (typeof result === 'string') return { text: result };
    if (!result || typeof result !== 'object') return { text: '' };
    return { text: typeof result.text === 'string' ? result.text : '', ...result };
}

async function callProvider({ prompt, model, signal, onUpdate, sendMessage }) {
    let result;
    try {
        result = await sendMessage(prompt, model, [], signal, onUpdate);
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        throw new GeminiApiError(502, `Gemini upstream request failed: ${getErrorMessage(error)}`, {
            statusText: 'BAD_GATEWAY',
        });
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
    if (!normalized.text) {
        throw new GeminiApiError(502, 'Gemini upstream returned no text response.', {
            statusText: 'BAD_GATEWAY',
        });
    }
    return normalized;
}

async function readRequestBody(request, maxBodyBytes) {
    return await new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBodyBytes) {
                reject(new GeminiApiError(413, `Request body exceeds ${maxBodyBytes} bytes.`));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('aborted', () => reject(new GeminiApiError(499, 'Client closed the request.')));
        request.on('error', (error) => reject(error));
        request.on('end', () => {
            if (size === 0) {
                reject(new GeminiApiError(400, 'Request body must be a JSON object.'));
                return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                const parsed = JSON.parse(raw);
                if (!isObject(parsed)) throw new Error('not an object');
                resolve(parsed);
            } catch {
                reject(new GeminiApiError(400, 'Request body must contain valid JSON.'));
            }
        });
    });
}

function getActionPath(pathname) {
    const parsed = parseModelPath(pathname);
    if (!parsed) return null;
    return parsed;
}

function getRequestModel(model) {
    const normalized = normalizeModelId(model);
    return normalized;
}

async function handleGenerate(request, response, options, model, method) {
    const body = await readRequestBody(request, options.maxBodyBytes);
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
        throw new GeminiApiError(400, 'contents must be a non-empty array.', { param: 'contents' });
    }

    const context = buildPrompt(body);
    const targetModel = getRequestModel(model);
    const stream = method === 'streamGenerateContent';

    if (!stream) {
        const result = await callProvider({
            prompt: context.prompt,
            model: targetModel,
            signal: request.signal,
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
    response.flushHeaders?.();

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', () => {
        if (!response.writableEnded) controller.abort();
    });

    const shouldBufferForTools =
        context.declarations.length > 0 && context.toolMode.mode !== 'NONE';
    let latestText = '';
    let streamedText = '';

    try {
        const result = await callProvider({
            prompt: context.prompt,
            model: targetModel,
            signal: controller.signal,
            sendMessage: options.sendMessage,
            onUpdate: shouldBufferForTools
                ? undefined
                : (nextText) => {
                      const next = String(nextText || '');
                      const delta = next.startsWith(streamedText)
                          ? next.slice(streamedText.length)
                          : next;
                      streamedText = next;
                      latestText = next;
                      if (delta) {
                          writeSse(response, {
                              candidates: [
                                  {
                                      content: { role: 'model', parts: [{ text: delta }] },
                                      index: 0,
                                  },
                              ],
                              modelVersion: targetModel,
                          });
                      }
                  },
        });
        latestText = result.text;

        if (shouldBufferForTools) {
            const parts = toResponseParts(result.text, context);
            writeSse(response, {
                candidates: [createCandidate(parts)],
                modelVersion: targetModel,
                usageMetadata: createUsageMetadata(context.prompt, result.text),
            });
        } else if (latestText.startsWith(streamedText) && latestText.length > streamedText.length) {
            writeSse(response, {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [{ text: latestText.slice(streamedText.length) }],
                        },
                        index: 0,
                    },
                ],
                modelVersion: targetModel,
            });
        }

        if (!shouldBufferForTools) {
            writeSse(response, {
                candidates: [createCandidate([])],
                modelVersion: targetModel,
                usageMetadata: createUsageMetadata(context.prompt, latestText),
            });
        }
        endSse(response);
    } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
            if (!response.writableEnded) response.end();
            return;
        }
        writeSse(response, createErrorBody(error));
        endSse(response);
    } finally {
        request.off('aborted', abort);
    }
}

async function handleCountTokens(request, response, options) {
    const body = await readRequestBody(request, options.maxBodyBytes);
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
        throw new GeminiApiError(400, 'contents must be a non-empty array.', { param: 'contents' });
    }
    const context = buildPrompt(body);
    writeJson(response, 200, {
        totalTokens: estimateTokens(context.prompt),
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: estimateTokens(context.prompt) }],
    });
}

async function routeRequest(request, response, options) {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
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
            auth: 'none',
            protocol: 'gemini',
        });
        return;
    }

    if (
        request.method === 'GET' &&
        (pathname === '/models' || pathname === '/v1/models' || pathname === '/v1beta/models')
    ) {
        writeJson(response, 200, listModelsResponse());
        return;
    }

    const action = getActionPath(pathname);
    if (!action) {
        throw new GeminiApiError(404, 'Route not found.');
    }

    if (request.method === 'GET' && action.method === null) {
        const knownModel = getModelNames().includes(normalizeModelId(action.model));
        if (!knownModel) throw new GeminiApiError(404, `Model ${action.model} not found.`);
        writeJson(response, 200, modelResource(action.model));
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
        await handleCountTokens(request, response, options);
        return;
    }

    throw new GeminiApiError(404, `Unsupported model method: ${action.method}.`);
}

/**
 * Creates a pure Gemini-format HTTP server backed by the project's anonymous
 * Gemini Web provider. No API key or Authorization header is required.
 */
export function createGemini2ApiServer(options = {}) {
    const resolvedOptions = {
        maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
        sendMessage: sendNoAuthGeminiMessage,
        ...options,
    };

    if (typeof resolvedOptions.sendMessage !== 'function') {
        throw new TypeError('sendMessage must be a function.');
    }

    return createServer(async (request, response) => {
        setCorsHeaders(response);
        try {
            await routeRequest(request, response, resolvedOptions);
        } catch (error) {
            if (error?.name === 'AbortError' || response.writableEnded) return;
            if (!response.headersSent) setCorsHeaders(response);
            writeError(response, error);
        }
    });
}

export async function startGemini2ApiServer(options = {}) {
    const host = options.host || process.env.GEMINI_2API_HOST || DEFAULT_HOST;
    const configuredPort =
        options.port ?? process.env.GEMINI_2API_PORT ?? process.env.PORT ?? DEFAULT_PORT;
    const port = Number(configuredPort);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new TypeError(`Invalid port: ${configuredPort}`);
    }

    const server = createGemini2ApiServer(options);
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
