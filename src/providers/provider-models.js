/**
 * 各提供商支持的模型列表
 * 用于前端UI选择不支持的模型
 */

export const PROVIDER_MODELS = {
    'gemini-cli-oauth': [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-pro-preview-06-05',
        'gemini-2.5-flash-preview-09-2025',
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-3.1-pro-preview',
    ],
    'gemini-antigravity': [
        'gemini-2.5-computer-use-preview-10-2025',
        'gemini-3-pro-image-preview',
        'gemini-3.1-pro-preview',
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
        'gemini-2.5-flash-preview',
        'gemini-claude-sonnet-4-5',
        'gemini-claude-sonnet-4-5-thinking',
        'gemini-claude-opus-4-5-thinking',
        'gemini-claude-opus-4-6-thinking'
    ],
    'claude-custom': [],
    'claude-kiro-oauth': [
        'claude-haiku-4-5',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-3-7-sonnet-20250219'
    ],
    'openai-custom': [],
    'openaiResponses-custom': [],
    'openai-qwen-oauth': [
        'qwen3-coder-plus',
        'qwen3-coder-flash',
        'coder-model',
        'vision-model'
    ],
    'openai-iflow': [
        // iFlow 特有模型
        'iflow-rome-30ba3b',
        // Qwen 模型
        'qwen3-coder-plus',
        'qwen3-max',
        'qwen3-vl-plus',
        'qwen3-max-preview',
        'qwen3-32b',
        'qwen3-235b-a22b-thinking-2507',
        'qwen3-235b-a22b-instruct',
        'qwen3-235b',
        // Kimi 模型
        'kimi-k2-0905',
        'kimi-k2',
        // GLM 模型
        'glm-4.6',
        // DeepSeek 模型
        'deepseek-v3.2',
        'deepseek-r1',
        'deepseek-v3',
        // 手动定义
        'glm-4.7',
        'glm-5',
        'kimi-k2.5',
        'minimax-m2.1',
        'minimax-m2.5',
    ],
    'openai-codex-oauth': [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark'
    ],
    'forward-api': []
};

/**
 * 提供商模型别名映射（alias -> canonical）
 * 用于兼容客户端传入的简写/历史模型名。
 */
export const PROVIDER_MODEL_ALIASES = {
    'gemini-cli-oauth': {
        'gemini-3.1-pro': 'gemini-3.1-pro-preview',
        'gemini-3-pro': 'gemini-3-pro-preview',
        'gemini-3-flash': 'gemini-3-flash-preview',
        'gemini-2.5-pro-preview': 'gemini-2.5-pro-preview-06-05',
        'gemini-2.5-flash-preview': 'gemini-2.5-flash-preview-09-2025'
    },
    'gemini-antigravity': {
        'gemini-3.1-pro': 'gemini-3.1-pro-preview',
        'gemini-3-pro': 'gemini-3-pro-preview',
        'gemini-3-flash': 'gemini-3-flash-preview',
        'gemini-3-pro-image': 'gemini-3-pro-image-preview',
        'gemini-2.5-flash': 'gemini-2.5-flash-preview'
    }
};

/**
 * 规范化提供商模型名（含别名解析）
 * @param {string} providerType - 提供商类型
 * @param {string} model - 原始模型名
 * @returns {string} 规范化后的模型名
 */
export function normalizeProviderModel(providerType, model) {
    if (typeof model !== 'string') {
        return model;
    }

    const trimmedModel = model.trim();
    if (!trimmedModel) {
        return trimmedModel;
    }

    const cleanModel = trimmedModel.startsWith('models/')
        ? trimmedModel.substring('models/'.length)
        : trimmedModel;

    const isAntiModel = cleanModel.startsWith('anti-');
    const baseModel = isAntiModel ? cleanModel.substring('anti-'.length) : cleanModel;

    const aliasMap = PROVIDER_MODEL_ALIASES[providerType] || {};
    const normalizedBaseModel = aliasMap[baseModel] || baseModel;

    return isAntiModel ? `anti-${normalizedBaseModel}` : normalizedBaseModel;
}

/**
 * 检查提供商是否支持指定模型（含别名解析）
 * @param {string} providerType - 提供商类型
 * @param {string} model - 原始模型名
 * @returns {boolean} 是否支持
 */
export function isProviderModelSupported(providerType, model) {
    if (typeof model !== 'string' || !model.trim()) {
        return false;
    }

    if (!Object.prototype.hasOwnProperty.call(PROVIDER_MODELS, providerType)) {
        return false;
    }

    const providerModels = getProviderModels(providerType);
    const normalizedModel = normalizeProviderModel(providerType, model);

    // 空模型列表表示不限制模型（如 custom provider）
    if (providerModels.length === 0) {
        return true;
    }

    if (providerModels.includes(normalizedModel)) {
        return true;
    }

    // anti-* 仅对 gemini-cli-oauth 生效
    if (normalizedModel.startsWith('anti-')) {
        if (providerType !== 'gemini-cli-oauth') {
            return false;
        }
        const baseModel = normalizedModel.substring('anti-'.length);
        return providerModels.includes(baseModel);
    }

    return false;
}

/**
 * 获取指定提供商类型支持的模型列表
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    return PROVIDER_MODELS[providerType] || [];
}

/**
 * 获取所有提供商的模型列表
 * @returns {Object} 所有提供商的模型映射
 */
export function getAllProviderModels() {
    return PROVIDER_MODELS;
}
