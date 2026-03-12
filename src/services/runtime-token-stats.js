const runtimeTokenStatsStore = new Map();
const collectorStartedAt = new Date().toISOString();

function normalizeInstanceId(uuid) {
    return uuid || 'unknown';
}

function getProviderProtocol(providerType = '') {
    if (providerType === 'openai-codex-oauth') {
        return 'codex';
    }

    if (providerType.startsWith('openaiResponses')) {
        return 'openaiResponses';
    }

    const hyphenIndex = providerType.indexOf('-');
    return hyphenIndex === -1 ? providerType : providerType.substring(0, hyphenIndex);
}

function getProviderKey(providerType, uuid) {
    return `${providerType}:${normalizeInstanceId(uuid)}`;
}

function toTokenCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function createNormalizedUsage(usage, {
    inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0,
    reasoningTokens = 0,
    totalTokens = null,
} = {}) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const normalizedInput = toTokenCount(inputTokens);
    const normalizedOutput = toTokenCount(outputTokens);
    const normalizedCached = toTokenCount(cachedTokens);
    const normalizedReasoning = toTokenCount(reasoningTokens);
    const normalizedTotal = totalTokens === null
        ? normalizedInput + normalizedOutput
        : toTokenCount(totalTokens);

    return {
        inputTokens: normalizedInput,
        outputTokens: normalizedOutput,
        cachedTokens: normalizedCached,
        reasoningTokens: normalizedReasoning,
        totalTokens: normalizedTotal || (normalizedInput + normalizedOutput),
    };
}

function extractGeminiUsage(payload) {
    const usage = payload?.usageMetadata || payload?.response?.usageMetadata;
    return createNormalizedUsage(usage, {
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        cachedTokens: usage?.cachedContentTokenCount,
        reasoningTokens: usage?.thoughtsTokenCount,
        totalTokens: usage?.totalTokenCount,
    });
}

function extractOpenAIUsage(payload) {
    const usage = payload?.usage;
    return createNormalizedUsage(usage, {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
        totalTokens: usage?.total_tokens,
    });
}

function extractResponsesUsage(payload) {
    const usage = payload?.usage || payload?.response?.usage;
    return createNormalizedUsage(usage, {
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedTokens: usage?.input_tokens_details?.cached_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        totalTokens: usage?.total_tokens,
    });
}

function extractClaudeUsage(payload) {
    const usage = payload?.usage || payload?.message?.usage;
    return createNormalizedUsage(usage, {
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedTokens: usage?.cache_read_input_tokens,
        totalTokens: usage?.total_tokens,
    });
}

function cloneStats(stats) {
    if (!stats) {
        return null;
    }

    return {
        since: stats.since,
        lastUpdated: stats.lastUpdated,
        requests: stats.requests,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cachedTokens: stats.cachedTokens,
        reasoningTokens: stats.reasoningTokens,
        totalTokens: stats.totalTokens,
    };
}

export function createEmptyRuntimeTokenStats() {
    return cloneStats({
        since: collectorStartedAt,
        lastUpdated: null,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    });
}

export function extractRuntimeTokenUsage(payload, providerType) {
    const protocol = getProviderProtocol(providerType);

    if (protocol === 'gemini') {
        return extractGeminiUsage(payload);
    }

    if (protocol === 'claude') {
        return extractClaudeUsage(payload);
    }

    if (protocol === 'openaiResponses' || protocol === 'codex') {
        return extractResponsesUsage(payload);
    }

    if (protocol === 'openai' || protocol === 'grok' || protocol === 'forward') {
        return extractOpenAIUsage(payload);
    }

    return extractGeminiUsage(payload)
        || extractResponsesUsage(payload)
        || extractOpenAIUsage(payload)
        || extractClaudeUsage(payload);
}

export function mergeRuntimeTokenUsage(currentUsage, nextUsage) {
    if (!nextUsage) {
        return currentUsage || null;
    }

    if (!currentUsage) {
        return { ...nextUsage };
    }

    const inputTokens = Math.max(currentUsage.inputTokens, nextUsage.inputTokens);
    const outputTokens = Math.max(currentUsage.outputTokens, nextUsage.outputTokens);
    const cachedTokens = Math.max(currentUsage.cachedTokens, nextUsage.cachedTokens);
    const reasoningTokens = Math.max(currentUsage.reasoningTokens, nextUsage.reasoningTokens);
    const explicitTotalTokens = Math.max(currentUsage.totalTokens, nextUsage.totalTokens);

    return {
        inputTokens,
        outputTokens,
        cachedTokens,
        reasoningTokens,
        totalTokens: Math.max(explicitTotalTokens, inputTokens + outputTokens),
    };
}

export function recordRuntimeTokenUsage({ providerType, uuid, usage }) {
    if (!usage || !providerType) {
        return null;
    }

    const key = getProviderKey(providerType, uuid);
    const currentStats = runtimeTokenStatsStore.get(key) || {
        since: collectorStartedAt,
        lastUpdated: null,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
    };

    currentStats.requests += 1;
    currentStats.inputTokens += usage.inputTokens;
    currentStats.outputTokens += usage.outputTokens;
    currentStats.cachedTokens += usage.cachedTokens;
    currentStats.reasoningTokens += usage.reasoningTokens;
    currentStats.totalTokens += usage.totalTokens || (usage.inputTokens + usage.outputTokens);
    currentStats.lastUpdated = new Date().toISOString();

    runtimeTokenStatsStore.set(key, currentStats);
    return cloneStats(currentStats);
}

export function getRuntimeTokenStats(providerType, uuid) {
    return cloneStats(runtimeTokenStatsStore.get(getProviderKey(providerType, uuid)));
}

export function resetRuntimeTokenStats() {
    runtimeTokenStatsStore.clear();
}
