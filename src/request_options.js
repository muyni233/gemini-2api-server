// Ordinal preferences, not equivalent token budgets across APIs.
const EFFORT_TO_THINK = Object.freeze({
    none: 4,
    minimal: 4,
    low: 3,
    medium: 2,
    high: 1,
    xhigh: 0,
    max: 0,
});
const GEMINI_LEVEL_TO_THINK = Object.freeze({ minimal: 4, low: 3, medium: 2, high: 0 });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readThinking(request) {
    const preferences = [
        request.reasoning_effort,
        request.reasoningEffort,
        request.reasoning?.effort,
    ];
    for (const value of preferences) {
        const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (Object.hasOwn(EFFORT_TO_THINK, level)) return EFFORT_TO_THINK[level];
    }
    // Keep spelling priority independent of JSON property order.
    for (const config of [request.generationConfig, request.generation_config]) {
        for (const thinking of [config?.thinkingConfig, config?.thinking_config]) {
            for (const value of [thinking?.thinkingLevel, thinking?.thinking_level]) {
                const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
                if (Object.hasOwn(GEMINI_LEVEL_TO_THINK, level))
                    return GEMINI_LEVEL_TO_THINK[level];
            }
        }
    }
}

function readDeclarations(tools) {
    const declarations = new Map();
    for (const tool of Array.isArray(tools) ? tools : []) {
        for (const raw of [tool?.functionDeclarations, tool?.function_declarations]) {
            for (const declaration of Array.isArray(raw) ? raw : []) {
                if (!isObject(declaration) || typeof declaration.name !== 'string') continue;
                const name = declaration.name.trim();
                const parameters =
                    declaration.parametersJsonSchema ??
                    declaration.parameters_json_schema ??
                    declaration.parameters ??
                    {};
                if (!name || !isObject(parameters) || declarations.has(name)) continue;
                declarations.set(name, {
                    name,
                    parameters,
                    description:
                        typeof declaration.description === 'string' ? declaration.description : '',
                });
            }
        }
    }
    return [...declarations.values()];
}

function readTools(request) {
    const disabled = { declarations: [], toolMode: 'NONE' };
    const toolConfig = request.toolConfig ?? request.tool_config;
    if (toolConfig != null && !isObject(toolConfig)) return disabled;
    const config = toolConfig?.functionCallingConfig ?? toolConfig?.function_calling_config;
    if (config != null && !isObject(config)) return disabled;
    const rawMode = config?.mode ?? 'AUTO';
    const mode = typeof rawMode === 'string' ? rawMode.trim().toUpperCase() : '';
    if (!['AUTO', 'ANY', 'NONE', 'MODE_UNSPECIFIED'].includes(mode) || mode === 'NONE')
        return disabled;
    let allowed = config?.allowedFunctionNames ?? config?.allowed_function_names ?? [];
    if (typeof allowed === 'string') allowed = [allowed];
    if (!Array.isArray(allowed)) return disabled;
    let declarations = readDeclarations(request.tools);
    // Filter once. An invalid/nonmatching allowlist must never enable all tools.
    if (allowed.length)
        declarations = declarations.filter((declaration) => allowed.includes(declaration.name));
    if (!declarations.length) return disabled;
    return { declarations, toolMode: mode === 'MODE_UNSPECIFIED' ? 'AUTO' : mode };
}

export function normalizeRequestOptions(request) {
    return { thinking: readThinking(request), ...readTools(request) };
}
