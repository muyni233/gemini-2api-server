// Bridge-defined ordinal preferences, not equivalent token budgets across APIs.
const EFFORT_TO_THINK = Object.freeze({
    none: 4,
    minimal: 4,
    low: 3,
    medium: 2,
    high: 1,
    xhigh: 0,
    max: 0,
});
// HIGH is the highest native Gemini level; it must reach Web's deepest setting.
const GEMINI_LEVEL_TO_THINK = Object.freeze({ minimal: 4, low: 3, medium: 2, high: 0 });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function recordAdjustment(adjustments, param) {
    const name = String(param).slice(0, 128).toWellFormed();
    if (adjustments.includes(name)) return;
    if (adjustments.length < 16) adjustments.push(name);
    else if (!adjustments.includes('...')) adjustments.push('...');
}

function readThinking(request, warn) {
    let thinking;
    const add = (value, param, native = false) => {
        if (value == null) return;
        if (typeof value !== 'string') {
            warn(param);
            return;
        }
        const level = value.trim().toLowerCase();
        if (
            ['auto', 'default'].includes(level) ||
            (native && level === 'thinking_level_unspecified')
        )
            return;
        const mapping = native ? GEMINI_LEVEL_TO_THINK : EFFORT_TO_THINK;
        if (!Object.hasOwn(mapping, level)) {
            warn(param);
            return;
        }
        const mode = mapping[level];
        if (!thinking) thinking = { mode, param };
        else if (thinking.mode !== mode) warn(param);
    };
    // Fixed priority, independent of JSON property order. An invalid preference
    // does not prevent a lower-priority valid field from taking effect.
    for (const key of ['reasoning_effort', 'reasoningEffort']) add(request[key], key);
    if (request.reasoning != null) {
        if (!isObject(request.reasoning)) warn('reasoning');
        else {
            add(request.reasoning.effort, 'reasoning.effort');
            for (const key of Object.keys(request.reasoning))
                if (key !== 'effort') warn('reasoning.' + key);
        }
    }
    for (const field of ['cachedContent', 'cached_content', 'safetySettings', 'safety_settings']) {
        if (
            request[field] != null &&
            !(Array.isArray(request[field]) && request[field].length === 0)
        )
            warn(field);
    }
    for (const configKey of ['generationConfig', 'generation_config']) {
        const config = request[configKey];
        if (config == null) continue;
        if (!isObject(config)) {
            warn(configKey);
            continue;
        }
        for (const [key, value] of Object.entries(config)) {
            if (
                ['candidateCount', 'candidate_count'].includes(key) &&
                (value === 1 || value === '1')
            )
                continue;
            if (
                ['responseMimeType', 'response_mime_type'].includes(key) &&
                typeof value === 'string' &&
                value.trim().toLowerCase() === 'text/plain'
            )
                continue;
            if (!['thinkingConfig', 'thinking_config'].includes(key)) warn(configKey + '.' + key);
        }
        for (const key of ['thinkingConfig', 'thinking_config']) {
            const value = config[key];
            if (value == null) continue;
            const param = configKey + '.' + key;
            if (!isObject(value)) {
                warn(param);
                continue;
            }
            for (const option of ['thinkingLevel', 'thinking_level'])
                add(value[option], param + '.' + option, true);
            for (const [option, setting] of Object.entries(value)) {
                if (['thinkingLevel', 'thinking_level'].includes(option)) continue;
                if (
                    ['includeThoughts', 'include_thoughts'].includes(option) &&
                    (setting === false || setting == null)
                )
                    continue;
                warn(param + '.' + option);
            }
        }
    }
    return thinking;
}

function readDeclarations(tools, warn) {
    if (tools == null) return [];
    if (!Array.isArray(tools)) {
        warn('tools');
        return [];
    }
    const declarations = [];
    const seen = new Set();
    tools.forEach((tool, index) => {
        const param = 'tools[' + index + ']';
        if (!isObject(tool)) {
            warn(param);
            return;
        }
        for (const key of Object.keys(tool)) {
            if (!['functionDeclarations', 'function_declarations'].includes(key))
                warn(param + '.' + key);
        }
        for (const key of ['functionDeclarations', 'function_declarations']) {
            const raw = tool[key];
            if (raw == null) continue;
            if (!Array.isArray(raw)) {
                warn(param + '.' + key);
                continue;
            }
            raw.forEach((declaration, declarationIndex) => {
                const path = param + '.' + key + '[' + declarationIndex + ']';
                if (
                    !isObject(declaration) ||
                    typeof declaration.name !== 'string' ||
                    !declaration.name.trim()
                ) {
                    warn(path);
                    return;
                }
                const name = declaration.name.trim();
                const parameters =
                    declaration.parametersJsonSchema ??
                    declaration.parameters_json_schema ??
                    declaration.parameters ??
                    {};
                if (!isObject(parameters) || seen.has(name)) {
                    warn(path);
                    return;
                }
                seen.add(name);
                declarations.push({
                    name,
                    parameters,
                    description:
                        typeof declaration.description === 'string' ? declaration.description : '',
                });
            });
        }
    });
    return declarations;
}

function readToolMode(toolConfig, declarations, warn) {
    const disabled = () => ({ mode: 'NONE', allowedFunctionNames: [] });
    if (toolConfig == null) return { mode: 'AUTO', allowedFunctionNames: [] };
    if (!isObject(toolConfig)) {
        warn('toolConfig');
        return disabled();
    }
    for (const key of Object.keys(toolConfig)) {
        if (!['functionCallingConfig', 'function_calling_config'].includes(key))
            warn('toolConfig.' + key);
    }
    const config = toolConfig.functionCallingConfig ?? toolConfig.function_calling_config;
    if (config == null) return { mode: 'AUTO', allowedFunctionNames: [] };
    const param = 'toolConfig.functionCallingConfig';
    if (!isObject(config)) {
        warn(param);
        return disabled();
    }
    const mode =
        config.mode == null || config.mode === 'MODE_UNSPECIFIED'
            ? 'AUTO'
            : typeof config.mode === 'string'
              ? config.mode.trim().toUpperCase()
              : '';
    if (!['AUTO', 'ANY', 'NONE'].includes(mode)) {
        warn(param + '.mode');
        return disabled();
    }
    let allowed = config.allowedFunctionNames ?? config.allowed_function_names ?? [];
    if (typeof allowed === 'string') {
        warn(param + '.allowedFunctionNames');
        allowed = [allowed];
    }
    if (!Array.isArray(allowed)) {
        warn(param + '.allowedFunctionNames');
        return disabled();
    }
    const names = new Set(declarations.map((d) => d.name));
    const filtered = allowed.filter((name) => typeof name === 'string' && names.has(name));
    if (filtered.length !== allowed.length) warn(param + '.allowedFunctionNames');
    // Dropping an invalid allowlist must not accidentally enable every function.
    if (allowed.length > 0 && filtered.length === 0) return disabled();
    if (mode === 'ANY' && declarations.length === 0) {
        warn(param + '.mode');
        return disabled();
    }
    return { mode, allowedFunctionNames: filtered };
}

export function normalizeRequestOptions(request, adjustments = []) {
    const warn = (param) => recordAdjustment(adjustments, param);
    const thinking = readThinking(request, warn);
    const declarations = readDeclarations(request.tools, warn);
    const toolMode = readToolMode(request.toolConfig ?? request.tool_config, declarations, warn);
    return { thinking, declarations, toolMode, adjustments };
}
