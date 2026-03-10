import { OAuth2Client } from 'google-auth-library';
import { GaxiosError } from 'gaxios';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import open from 'open';
import { API_ACTIONS, formatExpiryTime, isRetryableNetworkError, formatExpiryLog } from '../../utils/common.js';
import { getProviderModels, normalizeProviderModel, isProviderModelSupported } from '../provider-models.js';
import { handleGeminiCliOAuth } from '../../auth/oauth-handlers.js';
import { getProxyConfigForProvider } from '../../utils/proxy-utils.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { MODEL_PROVIDER } from '../../utils/common.js';

// 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 5,
    timeout: 120000,
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 5,
    timeout: 120000,
});

// --- Constants ---
const AUTH_REDIRECT_PORT = 8085;
const CREDENTIALS_DIR = '.gemini';
const CREDENTIALS_FILE = 'oauth_creds.json';
const DEFAULT_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const DEFAULT_CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const GEMINI_MODELS = getProviderModels(MODEL_PROVIDER.GEMINI_CLI);
const DEFAULT_REQUEST_MAX_RETRIES = 10;
const QUOTA_BACKOFF_JITTER_RATIO = 0.2;
const MAX_TRANSIENT_ERROR_RETRIES = 2;
const NO_CAPACITY_IP_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_FIXED_IP_RACE_CONCURRENCY = 1;
const DEFAULT_FIXED_IP_RACE_ROUNDS = 3;
const DEFAULT_FIXED_IP_RACE_REQUEST_DELAY_MS = 2000;
const FIXED_IP_RACE_INTERNAL_ABORT = Symbol('gemini-fixed-ip-race-internal-abort');
export const DEFAULT_GEMINI_FIXED_IPS = Object.freeze([
    '64.233.161.95',
    '142.250.65.74',
    '142.250.65.234',
    '142.250.69.42',
    '142.250.74.10',
    '142.250.180.10',
    '142.250.181.170',
    '142.250.201.170',
    '142.250.217.234',
    '142.251.36.106',
    '142.251.37.10',
    '142.251.45.74',
    '142.251.143.106',
    '142.251.208.106',
    '142.251.208.170',
    '142.251.209.42',
    '172.217.16.138',
    '172.217.17.106',
    '172.217.17.202',
    '172.217.168.74',
    '172.217.171.74',
    '173.194.220.95',
    '216.239.32.223',
]);
const RETRYABLE_ABORT_PATTERNS = [
    'the operation was aborted',
    'aborterror',
    'request was aborted',
];

function buildGeminiCliUserAgent(configuredUserAgent, model = 'unknown') {
    if (typeof configuredUserAgent === 'string' && configuredUserAgent.trim()) {
        return configuredUserAgent.trim();
    }

    const version = process.env.CLI_VERSION || 'compatible';
    return `GeminiCLI/${version}/${model} (${process.platform}; ${process.arch})`;
}

function normalizeGeminiFixedIpList(rawValue) {
    if (rawValue === undefined || rawValue === null) {
        return [...DEFAULT_GEMINI_FIXED_IPS];
    }

    const entries = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue)
            .split(/[\s,]+/);

    const uniqueIps = [];
    for (const entry of entries) {
        if (entry === undefined || entry === null) {
            continue;
        }

        const candidate = String(entry).trim();
        if (!candidate || uniqueIps.includes(candidate)) {
            continue;
        }

        uniqueIps.push(candidate);
    }

    return uniqueIps;
}

function normalizePositiveInteger(rawValue, fallbackValue) {
    const normalized = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallbackValue;
    }

    return normalized;
}

function normalizeNonNegativeInteger(rawValue, fallbackValue) {
    const normalized = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(normalized) || normalized < 0) {
        return fallbackValue;
    }

    return normalized;
}

function extractHostnameFromUrl(rawUrl) {
    if (!rawUrl) {
        return null;
    }

    try {
        const parsed = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
        return parsed.hostname || null;
    } catch {
        return null;
    }
}

function extractGeminiErrorText(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    const errorMessage = value?.error?.message;
    if (typeof errorMessage === 'string') {
        return errorMessage;
    }

    const topLevelMessage = value?.message;
    if (typeof topLevelMessage === 'string') {
        return topLevelMessage;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function isGeminiNoCapacityText(text) {
    const normalized = String(text || '').toLowerCase();
    return normalized.includes('no capacity available for model') &&
        normalized.includes('on the server');
}

function isGeminiQuotaExhaustedText(text) {
    return String(text || '').toLowerCase().includes('you have exhausted your capacity on this model');
}

function shouldRotateGeminiQuotaExhaustedFixedIp(model) {
    const normalizedModel = normalizeProviderModel(MODEL_PROVIDER.GEMINI_CLI, model);
    return normalizedModel === 'gemini-3.1-pro-preview';
}

function isRetryableAbortError(error) {
    const errorCode = String(error?.code || error?.cause?.name || '').toLowerCase();
    if (errorCode === 'aborterror') {
        return true;
    }

    const errorText = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase();
    return RETRYABLE_ABORT_PATTERNS.some((pattern) => errorText.includes(pattern));
}

function createAbortError(message = 'The operation was aborted.') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }

    const abortReason = signal.reason;
    if (abortReason instanceof Error) {
        throw abortReason;
    }

    throw createAbortError(typeof abortReason === 'string' && abortReason.trim()
        ? abortReason
        : 'The operation was aborted.');
}

function waitWithAbort(ms, signal) {
    throwIfAborted(signal);

    if (!Number.isFinite(ms) || ms <= 0) {
        return Promise.resolve();
    }

    if (!signal) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            signal.removeEventListener('abort', onAbort);
        };

        const finishResolve = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };

        const onAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            try {
                throwIfAborted(signal);
            } catch (error) {
                reject(error);
            }
        };

        timer = setTimeout(finishResolve, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export function classifyGeminiFixedIpResponse(response) {
    const status = Number(response?.status);
    const errorText = extractGeminiErrorText(response?.data);

    if (status === 429) {
        if (isGeminiNoCapacityText(errorText)) {
            return { action: 'rotate', reason: '429-no-capacity', errorText };
        }

        if (isGeminiQuotaExhaustedText(errorText)) {
            return { action: 'stop', reason: '429-quota-exhausted', errorText };
        }

        return { action: 'stop', reason: '429-other', errorText };
    }

    if (status >= 500 && status < 600) {
        return { action: 'rotate', reason: `${status}-server-error`, errorText };
    }

    return { action: 'stop', reason: `status-${status || 'unknown'}`, errorText };
}

export function classifyGeminiFixedIpError(error) {
    if (isRetryableNetworkError(error) || isRetryableAbortError(error)) {
        return {
            action: 'rotate',
            reason: error?.code || error?.cause?.name || 'network-error',
            errorText: extractGeminiErrorText(error?.message),
        };
    }

    return {
        action: 'stop',
        reason: error?.code || 'non-rotatable-error',
        errorText: extractGeminiErrorText(error?.message),
    };
}

export function buildGeminiIpCandidateSequence(ipList, preferredIp = null) {
    const uniqueIps = [];
    const addIp = (value) => {
        const candidate = String(value || '').trim();
        if (!candidate || uniqueIps.includes(candidate)) {
            return;
        }
        uniqueIps.push(candidate);
    };

    if (preferredIp) {
        addIp(preferredIp);
    }

    for (const ip of ipList || []) {
        addIp(ip);
    }

    return uniqueIps;
}

function prioritizeGeminiIpCandidates(ipList, preferredIp = null, blockedIps = []) {
    const blockedSet = new Set((blockedIps || []).map((ip) => String(ip || '').trim()).filter(Boolean));
    const ordered = buildGeminiIpCandidateSequence(ipList, preferredIp);
    if (blockedSet.size === 0) {
        return ordered;
    }
    return ordered.filter((ip) => !blockedSet.has(ip));
}

function parseDurationToMs(rawDuration) {
    if (rawDuration === undefined || rawDuration === null) {
        return null;
    }

    const text = String(rawDuration).trim();
    const durationMatch = text.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s)$/i);
    if (!durationMatch) {
        return null;
    }

    const value = Number.parseFloat(durationMatch[1]);
    if (!Number.isFinite(value)) {
        return null;
    }

    const unit = durationMatch[2].toLowerCase();
    const ms = unit === 'ms' ? value : value * 1000;
    return Math.max(0, Math.round(ms));
}

function getResponseHeaderValue(headers, headerName) {
    if (!headers || !headerName) {
        return null;
    }

    const normalizedHeaderName = String(headerName).toLowerCase();
    let headerValue;

    if (typeof headers.get === 'function') {
        headerValue = headers.get(normalizedHeaderName);
    } else if (Array.isArray(headers)) {
        const headerEntry = headers.find((entry) =>
            Array.isArray(entry) && String(entry[0]).toLowerCase() === normalizedHeaderName);
        headerValue = headerEntry ? headerEntry[1] : undefined;
    } else if (typeof headers === 'object') {
        const matchedHeaderKey = Object.keys(headers)
            .find((key) => String(key).toLowerCase() === normalizedHeaderName);
        headerValue = matchedHeaderKey ? headers[matchedHeaderKey] : undefined;
    }

    if (Array.isArray(headerValue)) {
        headerValue = headerValue[0];
    }

    if (headerValue === undefined || headerValue === null) {
        return null;
    }

    const normalizedValue = String(headerValue).trim();
    return normalizedValue || null;
}

function parseRetryAfterHeaderMs(headers) {
    const retryAfterValue = getResponseHeaderValue(headers, 'retry-after');
    if (retryAfterValue === undefined || retryAfterValue === null) {
        return null;
    }

    const raw = String(retryAfterValue).trim();
    if (!raw) {
        return null;
    }

    if (/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) {
        return Math.max(0, Math.round(Number.parseFloat(raw) * 1000));
    }

    const durationMs = parseDurationToMs(raw);
    if (durationMs !== null) {
        return durationMs;
    }

    const parsedDate = Date.parse(raw);
    if (!Number.isNaN(parsedDate)) {
        return Math.max(0, parsedDate - Date.now());
    }

    return null;
}

function formatServerTimingLogSuffix(headers) {
    const serverTiming = getResponseHeaderValue(headers, 'server-timing');
    return serverTiming ? ` | Server-Timing=${serverTiming}` : '';
}

function extractRetryDelayFromPayloadMs(payload) {
    if (payload === undefined || payload === null) {
        return null;
    }

    let text;
    if (typeof payload === 'string') {
        text = payload;
    } else {
        try {
            text = JSON.stringify(payload);
        } catch {
            return null;
        }
    }

    if (!text) {
        return null;
    }

    const delayCandidates = [];
    const retryInRegex = /please retry in\s+([0-9]+(?:\.[0-9]+)?(?:ms|s))/ig;
    let match;
    while ((match = retryInRegex.exec(text)) !== null) {
        const parsed = parseDurationToMs(match[1]);
        if (parsed !== null) {
            delayCandidates.push(parsed);
        }
    }

    const quotaResetRegex = /quota will reset after\s+([0-9]+(?:\.[0-9]+)?(?:ms|s))/ig;
    while ((match = quotaResetRegex.exec(text)) !== null) {
        const parsed = parseDurationToMs(match[1]);
        if (parsed !== null) {
            delayCandidates.push(parsed);
        }
    }

    const delayFieldRegex = /"(?:retryDelay|quotaResetDelay)"\s*:\s*"([0-9]+(?:\.[0-9]+)?(?:ms|s))"/ig;
    while ((match = delayFieldRegex.exec(text)) !== null) {
        const parsed = parseDurationToMs(match[1]);
        if (parsed !== null) {
            delayCandidates.push(parsed);
        }
    }

    if (delayCandidates.length === 0) {
        return null;
    }

    return Math.max(...delayCandidates);
}

function getQuotaRetryDelayHintMs(error) {
    const retryAfterHeaderMs = parseRetryAfterHeaderMs(error?.response?.headers);
    const payloadDelayMs = extractRetryDelayFromPayloadMs(error?.response?.data);
    const messageDelayMs = extractRetryDelayFromPayloadMs(error?.message);

    const allDelays = [retryAfterHeaderMs, payloadDelayMs, messageDelayMs]
        .filter((value) => Number.isFinite(value) && value >= 0);

    if (allDelays.length === 0) {
        return null;
    }

    return Math.max(...allDelays);
}

function computeQuotaRetryDelayMs(baseDelay, retryCount, quotaRetryDelayHintMs = null) {
    const exponentialDelay = baseDelay * Math.pow(2, retryCount);
    const minimumDelay = Math.max(exponentialDelay, quotaRetryDelayHintMs || 0);
    const jitter = minimumDelay * QUOTA_BACKOFF_JITTER_RATIO * Math.random();
    return Math.max(0, Math.round(minimumDelay + jitter));
}

function isAuthFailureResponse(status, error) {
    if (status === 401) {
        return true;
    }

    if (status !== 400) {
        return false;
    }

    const details = error?.response?.data;
    let detailsText = '';
    try {
        detailsText = typeof details === 'string' ? details : JSON.stringify(details || '');
    } catch {
        detailsText = String(details || '');
    }

    const messageText = String(error?.message || '');
    const combinedText = `${messageText} ${detailsText}`.toLowerCase();
    const authHints = [
        'unauth',
        'invalid_grant',
        'invalid_token',
        'token expired',
        'access token expired',
        'credential',
        'oauth'
    ];

    return authHints.some((hint) => combinedText.includes(hint));
}

function createUnsupportedModelError(requestedModel, normalizedModel = requestedModel) {
    const requested = typeof requestedModel === 'string' && requestedModel.trim()
        ? requestedModel
        : '<empty>';
    const normalized = typeof normalizedModel === 'string' && normalizedModel.trim()
        ? normalizedModel
        : requested;
    const normalizationHint = normalized !== requested ? ` Resolved as '${normalized}'.` : '';
    const supportedModels = GEMINI_MODELS.join(', ');
    const error = new Error(`[Gemini] Unsupported model '${requested}'.${normalizationHint} Supported models: ${supportedModels}`);
    error.statusCode = 400;
    error.code = 400;
    return error;
}

function resolve_gemini_model(model) {
    if (typeof model !== 'string' || !model.trim()) {
        throw createUnsupportedModelError(model);
    }
    const normalizedModel = normalizeProviderModel(MODEL_PROVIDER.GEMINI_CLI, model);
    if (!isProviderModelSupported(MODEL_PROVIDER.GEMINI_CLI, normalizedModel) || normalizedModel.startsWith('anti-')) {
        throw createUnsupportedModelError(model, normalizedModel);
    }
    return normalizedModel;
}

function is_anti_truncation_model(model) {
    if (typeof model !== 'string' || !model.startsWith('anti-')) {
        return false;
    }
    const originalModel = normalizeProviderModel(MODEL_PROVIDER.GEMINI_CLI, model.substring(5));
    return isProviderModelSupported(MODEL_PROVIDER.GEMINI_CLI, originalModel);
}

// 从防截断模型名中提取实际模型名
function extract_model_from_anti_model(model) {
    if (typeof model === 'string' && model.startsWith('anti-')) {
        return normalizeProviderModel(MODEL_PROVIDER.GEMINI_CLI, model.substring(5));
    }
    return model;
}

function toGeminiApiResponse(codeAssistResponse) {
    if (!codeAssistResponse) return null;
    const compliantResponse = { candidates: codeAssistResponse.candidates };
    if (codeAssistResponse.usageMetadata) compliantResponse.usageMetadata = codeAssistResponse.usageMetadata;
    if (codeAssistResponse.promptFeedback) compliantResponse.promptFeedback = codeAssistResponse.promptFeedback;
    if (codeAssistResponse.automaticFunctionCallingHistory) compliantResponse.automaticFunctionCallingHistory = codeAssistResponse.automaticFunctionCallingHistory;
    return compliantResponse;
}

function convertGeminiStreamChunksToNonStream(chunks) {
    let responseTemplate = null;
    let traceId = '';
    let finishReason = '';
    let modelVersion = '';
    let responseId = '';
    let role = '';
    let usageRaw = null;
    const parts = [];

    let pendingKind = '';
    let pendingText = '';
    let pendingThoughtSig = '';

    const flushPending = () => {
        if (!pendingKind) {
            return;
        }

        if (pendingKind === 'text') {
            if (pendingText) {
                parts.push({ text: pendingText });
            }
        } else if (pendingKind === 'thought') {
            if (pendingText || pendingThoughtSig) {
                const thoughtPart = {
                    thought: true,
                    text: pendingText,
                };
                if (pendingThoughtSig) {
                    thoughtPart.thoughtSignature = pendingThoughtSig;
                }
                parts.push(thoughtPart);
            }
        }

        pendingKind = '';
        pendingText = '';
        pendingThoughtSig = '';
    };

    const normalizePart = (part) => {
        const normalized = { ...part };
        const thoughtSignature = normalized.thoughtSignature || normalized.thought_signature;
        if (thoughtSignature) {
            normalized.thoughtSignature = thoughtSignature;
            delete normalized.thought_signature;
        }
        if (normalized.inline_data) {
            normalized.inlineData = normalized.inline_data;
            delete normalized.inline_data;
        }
        return normalized;
    };

    for (const chunk of chunks || []) {
        const responseNode = chunk?.response;
        if (!responseNode) {
            continue;
        }

        responseTemplate = responseNode;

        if (chunk.traceId) {
            traceId = chunk.traceId;
        }
        if (responseNode.candidates?.[0]?.content?.role) {
            role = responseNode.candidates[0].content.role;
        }
        if (responseNode.candidates?.[0]?.finishReason) {
            finishReason = responseNode.candidates[0].finishReason;
        }
        if (responseNode.modelVersion) {
            modelVersion = responseNode.modelVersion;
        }
        if (responseNode.responseId) {
            responseId = responseNode.responseId;
        }
        if (responseNode.usageMetadata) {
            usageRaw = responseNode.usageMetadata;
        } else if (chunk.usageMetadata) {
            usageRaw = chunk.usageMetadata;
        }

        const currentParts = responseNode.candidates?.[0]?.content?.parts;
        if (!Array.isArray(currentParts)) {
            continue;
        }

        for (const part of currentParts) {
            const hasFunctionCall = part.functionCall !== undefined;
            const hasInlineData = part.inlineData !== undefined || part.inline_data !== undefined;
            const thoughtSignature = part.thoughtSignature || part.thought_signature || '';
            const text = part.text || '';
            const thought = part.thought || false;

            if (hasFunctionCall || hasInlineData) {
                flushPending();
                parts.push(normalizePart(part));
                continue;
            }

            if (thought || part.text !== undefined) {
                const currentKind = thought ? 'thought' : 'text';
                if (pendingKind && pendingKind !== currentKind) {
                    flushPending();
                }
                pendingKind = currentKind;
                pendingText += text;
                if (currentKind === 'thought' && thoughtSignature) {
                    pendingThoughtSig = thoughtSignature;
                }
                continue;
            }

            flushPending();
            parts.push(normalizePart(part));
        }
    }

    flushPending();

    const result = responseTemplate
        ? JSON.parse(JSON.stringify(responseTemplate))
        : { candidates: [{ content: { role: 'model', parts: [] } }] };

    if (!Array.isArray(result.candidates) || !result.candidates[0]) {
        result.candidates = [{ content: { role: 'model', parts: [] } }];
    }
    if (!result.candidates[0].content) {
        result.candidates[0].content = { role: 'model', parts: [] };
    }

    result.candidates[0].content.parts = parts;

    if (role) {
        result.candidates[0].content.role = role;
    }
    if (finishReason) {
        result.candidates[0].finishReason = finishReason;
    }
    if (modelVersion) {
        result.modelVersion = modelVersion;
    }
    if (responseId) {
        result.responseId = responseId;
    }
    if (usageRaw) {
        result.usageMetadata = usageRaw;
    }

    return {
        response: result,
        traceId,
    };
}

function deriveGeminiSessionId(requestBody) {
    const existingSessionId = requestBody?.session_id || requestBody?.sessionId;
    if (typeof existingSessionId === 'string' && existingSessionId.trim()) {
        return existingSessionId.trim();
    }

    return `session-${randomUUID()}`;
}

function ensureGeminiSessionId(requestBody) {
    if (!requestBody || typeof requestBody !== 'object') {
        return null;
    }

    const sessionId = deriveGeminiSessionId(requestBody);
    requestBody.session_id = sessionId;
    delete requestBody.sessionId;

    return sessionId;
}

function buildGeminiPromptId(sessionId, externalRequestId, sequence) {
    if (typeof externalRequestId === 'string' && externalRequestId.trim()) {
        return `${sessionId}########${externalRequestId.trim()}`;
    }

    if (Number.isFinite(sequence) && sequence > 0) {
        return `${sessionId}########${sequence}`;
    }

    return `${sessionId}########${Date.now()}`;
}

/**
 * Ensures that all content parts in a request body have a 'role' property.
 * If 'systemInstruction' is present and lacks a role, it defaults to 'user'.
 * If any 'contents' entry lacks a role, it defaults to 'user'.
 * @param {Object} requestBody - The request body object.
 * @returns {Object} The modified request body with roles ensured.
 */
function ensureRolesInContents(requestBody) {
    delete requestBody.model;
    // delete requestBody.system_instruction;
    // delete requestBody.systemInstruction;
    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    if (requestBody.systemInstruction && !requestBody.systemInstruction.role) {
        requestBody.systemInstruction.role = 'user';
    }

    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        requestBody.contents.forEach(content => {
            if (!content.role) {
                content.role = 'user';
            }
        });

        // 如果存在 systemInstruction，将其放在 contents 索引 0 的位置
        // if (requestBody.systemInstruction) {
        //     // 检查 contents[0] 是否与 systemInstruction 内容相同
        //     const firstContent = requestBody.contents[0];
        //     let isSame = false;

        //     if (firstContent && firstContent.parts && requestBody.systemInstruction.parts) {
        //         // 比较 parts 数组的内容
        //         const firstContentText = firstContent.parts
        //             .filter(p => p?.text)
        //             .map(p => p.text)
        //             .join('\n');
        //         const systemInstructionText = requestBody.systemInstruction.parts
        //             .filter(p => p?.text)
        //             .map(p => p.text)
        //             .join('\n');
                
        //         isSame = firstContentText === systemInstructionText;
        //     }

        //     // 如果内容不同，则将 systemInstruction 插入到索引 0 的位置
        //     if (!isSame) {
        //         requestBody.contents.unshift({
        //             role: requestBody.systemInstruction.role || 'user',
        //             parts: requestBody.systemInstruction.parts
        //         });
        //     }
        //     delete requestBody.systemInstruction;
        // }
    }
    return requestBody;
}

async function* apply_anti_truncation_to_stream(service, model, requestBody, signal = undefined) {
    let currentRequest = { ...requestBody };
    let allGeneratedText = '';
    const baseMonitorRequestId = service.config?._monitorRequestId || null;

    while (true) {
        throwIfAborted(signal);

        // 发送请求并处理流式响应
        const apiRequest = service._buildCodeAssistGenerateRequest(model, currentRequest, baseMonitorRequestId);
        const stream = service.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest, false, 0, signal);

        let lastChunk = null;
        let hasContent = false;

        for await (const chunk of stream) {
            const response = toGeminiApiResponse(chunk.response);
            if (response && response.candidates && response.candidates[0]) {
                yield response;
                lastChunk = response;
                hasContent = true;
            }
        }

        // 检查是否因为达到token限制而截断
        if (lastChunk &&
            lastChunk.candidates &&
            lastChunk.candidates[0] &&
            lastChunk.candidates[0].finishReason === 'MAX_TOKENS') {

            // 提取已生成的文本内容
            if (lastChunk.candidates[0].content && lastChunk.candidates[0].content.parts) {
                const generatedParts = lastChunk.candidates[0].content.parts
                    .filter(part => part.text)
                    .map(part => part.text);

                if (generatedParts.length > 0) {
                    const currentGeneratedText = generatedParts.join('');
                    allGeneratedText += currentGeneratedText;

                    // 构建新的请求，包含之前的对话历史和继续指令
                    const newContents = [...requestBody.contents];

                    // 添加之前生成的内容作为模型响应
                    newContents.push({
                        role: 'model',
                        parts: [{ text: allGeneratedText }]
                    });

                    // 添加继续生成的指令
                    newContents.push({
                        role: 'user',
                        parts: [{ text: 'Please continue from where you left off.' }]
                    });

                    currentRequest = {
                        ...requestBody,
                        session_id: currentRequest.session_id || requestBody.session_id || requestBody.sessionId,
                        contents: newContents
                    };

                    // 继续下一轮请求
                    continue;
                }
            }
        }

        // 如果没有截断或无法继续，则退出循环
        break;
    }
}

export class GeminiApiService {
    constructor(config) {
        this.config = config;
        this.host = config.HOST;
        this.oauthCredsBase64 = config.GEMINI_OAUTH_CREDS_BASE64;
        this.oauthCredsFilePath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
        this.projectId = config.PROJECT_ID;
        this.uuid = config.uuid;
        this.codeAssistEndpoint = config.GEMINI_BASE_URL || DEFAULT_CODE_ASSIST_ENDPOINT;
        this.apiVersion = DEFAULT_CODE_ASSIST_API_VERSION;
        this.proxyConfig = getProxyConfigForProvider(config, 'gemini-cli-oauth');
        this.fixedIpList = normalizeGeminiFixedIpList(config.GEMINI_FIXED_IPS);
        this.fixedIpPreferredByHostname = new Map();
        this.fixedIpPreferredByModelHostname = new Map();
        this.fixedIpCooldownByModelHostname = new Map();
        this.fixedIpAgentCache = new Map();
        this.fixedIpTargetHostnames = new Set();
        this.availableModels = [];
        this.isInitialized = false;
        this.promptSequence = 0;

        const codeAssistHostname = extractHostnameFromUrl(this.codeAssistEndpoint);
        if (codeAssistHostname) {
            this.fixedIpTargetHostnames.add(codeAssistHostname);
        }
        this.fixedIpTargetHostnames.add('oauth2.googleapis.com');

        this.fixedIpRotationEnabled = config.GEMINI_FIXED_IP_ROTATION_ENABLED !== false &&
            !this.proxyConfig &&
            this.fixedIpList.length > 0;
        this.fixedIpRaceEnabled = this.fixedIpRotationEnabled && config.GEMINI_FIXED_IP_RACE_ENABLED !== false;
        this.fixedIpRaceConcurrency = normalizePositiveInteger(
            config.GEMINI_FIXED_IP_RACE_CONCURRENCY,
            DEFAULT_FIXED_IP_RACE_CONCURRENCY
        );
        this.fixedIpRaceRounds = normalizePositiveInteger(
            config.GEMINI_FIXED_IP_RACE_ROUNDS,
            DEFAULT_FIXED_IP_RACE_ROUNDS
        );
        this.fixedIpRaceRequestDelayMs = normalizeNonNegativeInteger(
            config.GEMINI_FIXED_IP_RACE_REQUEST_DELAY_MS,
            DEFAULT_FIXED_IP_RACE_REQUEST_DELAY_MS
        );
        this.fixedIpRaceFallbackToDns = config.GEMINI_FIXED_IP_RACE_FALLBACK_TO_DNS === true;
        this.fixedIpRaceDisableCooldown = config.GEMINI_FIXED_IP_RACE_DISABLE_COOLDOWN !== false;

        const oauth2Options = {
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
        };

        if (this.proxyConfig) {
            oauth2Options.transporterOptions = {
                agent: this.proxyConfig.httpsAgent,
            };
            logger.info('[Gemini] Using proxy for OAuth2Client');
        } else {
            oauth2Options.transporterOptions = {
                agent: httpsAgent,
            };
        }

        this.authClient = new OAuth2Client(oauth2Options);
        this._installFixedIpTransportAdapter();
    }

    _nextPromptSequence() {
        this.promptSequence += 1;
        return this.promptSequence;
    }

    _buildCodeAssistGenerateRequest(model, requestBody, monitorRequestId = null) {
        const sessionId = deriveGeminiSessionId(requestBody);
        const promptId = buildGeminiPromptId(sessionId, monitorRequestId, this._nextPromptSequence());
        const request = {
            ...requestBody,
            session_id: sessionId,
        };

        delete request.sessionId;

        logger.info(`[Gemini API] Prepared Code Assist identifiers | session_id=${request.session_id} | user_prompt_id=${promptId}`);

        return {
            model,
            project: this.projectId,
            user_prompt_id: promptId,
            request,
        };
    }

    _installFixedIpTransportAdapter() {
        if (this.proxyConfig && this.config.GEMINI_FIXED_IP_ROTATION_ENABLED !== false) {
            logger.info('[Gemini IP] Fixed IP rotation is disabled because gemini-cli-oauth is using a proxy.');
            return;
        }

        if (!this.fixedIpRotationEnabled) {
            if (this.config.GEMINI_FIXED_IP_ROTATION_ENABLED === false) {
                logger.info('[Gemini IP] Fixed IP rotation is disabled by config.');
            }
            return;
        }

        this.authClient.transporter.interceptors.request.add({
            resolved: async (requestOptions) => {
                if (!this._shouldUseFixedIpRotation(requestOptions?.url)) {
                    return requestOptions;
                }

                return {
                    ...requestOptions,
                    adapter: async (preparedRequestOptions, defaultAdapter) => {
                        return this._executeWithFixedIpRotation(preparedRequestOptions, defaultAdapter);
                    },
                };
            },
        });

        const raceModeSuffix = this.fixedIpRaceEnabled
            ? ` Race mode enabled (concurrency=${this.fixedIpRaceConcurrency}, rounds=${this.fixedIpRaceRounds}, requestDelayMs=${this.fixedIpRaceRequestDelayMs}, dnsFallback=${this.fixedIpRaceFallbackToDns}, disableCooldown=${this.fixedIpRaceDisableCooldown}).`
            : '';
        logger.info(`[Gemini IP] Fixed IP rotation enabled for hosts [${[...this.fixedIpTargetHostnames].join(', ')}] with ${this.fixedIpList.length} candidate IP(s).${raceModeSuffix}`);
    }

    _shouldUseFixedIpRotation(rawUrl) {
        if (!this.fixedIpRotationEnabled) {
            return false;
        }

        const hostname = extractHostnameFromUrl(rawUrl);
        if (!hostname) {
            return false;
        }

        return this.fixedIpTargetHostnames.has(hostname);
    }

    _buildFixedIpModelKey(hostname, model = null) {
        const normalizedHostname = String(hostname || '').trim();
        if (!normalizedHostname) {
            return null;
        }

        const normalizedModel = typeof model === 'string' ? model.trim() : '';
        return normalizedModel ? `${normalizedHostname}|${normalizedModel}` : normalizedHostname;
    }

    _buildFixedIpCooldownKey(hostname, model = null, fixedIp = null) {
        const modelKey = this._buildFixedIpModelKey(hostname, model);
        const normalizedIp = String(fixedIp || '').trim();
        if (!modelKey || !normalizedIp) {
            return null;
        }

        return `${modelKey}|${normalizedIp}`;
    }

    _getBlockedFixedIps(hostname, model = null) {
        const blockedIps = [];
        const now = Date.now();

        for (const ip of this.fixedIpList) {
            const cooldownKey = this._buildFixedIpCooldownKey(hostname, model, ip);
            if (!cooldownKey) {
                continue;
            }

            const blockedUntil = this.fixedIpCooldownByModelHostname.get(cooldownKey);
            if (!Number.isFinite(blockedUntil) || blockedUntil <= now) {
                this.fixedIpCooldownByModelHostname.delete(cooldownKey);
                continue;
            }

            blockedIps.push(ip);
        }

        return blockedIps;
    }

    _getFixedIpCandidates(hostname, model = null) {
        const modelKey = this._buildFixedIpModelKey(hostname, model);
        const preferredIp = modelKey
            ? this.fixedIpPreferredByModelHostname.get(modelKey) || this.fixedIpPreferredByHostname.get(hostname)
            : this.fixedIpPreferredByHostname.get(hostname);
        const blockedIps = this._getBlockedFixedIps(hostname, model);
        return prioritizeGeminiIpCandidates(this.fixedIpList, preferredIp, blockedIps);
    }

    _rememberSuccessfulFixedIp(hostname, fixedIp, model = null) {
        if (!hostname || !fixedIp) {
            return;
        }

        const modelKey = this._buildFixedIpModelKey(hostname, model);
        if (modelKey && model) {
            const previousIp = this.fixedIpPreferredByModelHostname.get(modelKey);
            this.fixedIpPreferredByModelHostname.set(modelKey, fixedIp);
            const cooldownKey = this._buildFixedIpCooldownKey(hostname, model, fixedIp);
            if (cooldownKey) {
                this.fixedIpCooldownByModelHostname.delete(cooldownKey);
            }

            if (previousIp !== fixedIp) {
                logger.info(`[Gemini IP] Cached fixed IP ${fixedIp} for ${hostname} on model ${model}.`);
            }
            return;
        }

        const previousIp = this.fixedIpPreferredByHostname.get(hostname);
        this.fixedIpPreferredByHostname.set(hostname, fixedIp);

        if (previousIp !== fixedIp) {
            logger.info(`[Gemini IP] Cached fixed IP ${fixedIp} for ${hostname}.`);
        }
    }

    _clearPreferredFixedIp(hostname, fixedIp, reason, model = null) {
        if (!hostname || !fixedIp) {
            return;
        }

        const modelKey = this._buildFixedIpModelKey(hostname, model);
        if (modelKey && model && this.fixedIpPreferredByModelHostname.get(modelKey) === fixedIp) {
            this.fixedIpPreferredByModelHostname.delete(modelKey);
            logger.info(`[Gemini IP] Cleared cached fixed IP ${fixedIp} for ${hostname} on model ${model} after ${reason}.`);
            return;
        }

        if (this.fixedIpPreferredByHostname.get(hostname) === fixedIp) {
            this.fixedIpPreferredByHostname.delete(hostname);
            logger.info(`[Gemini IP] Cleared cached fixed IP ${fixedIp} for ${hostname} after ${reason}.`);
        }
    }

    _markFixedIpCooldown(hostname, fixedIp, reason, model = null, cooldownMs = NO_CAPACITY_IP_COOLDOWN_MS) {
        const cooldownKey = this._buildFixedIpCooldownKey(hostname, model, fixedIp);
        if (!cooldownKey || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
            return;
        }

        const blockedUntil = Date.now() + cooldownMs;
        this.fixedIpCooldownByModelHostname.set(cooldownKey, blockedUntil);

        if (model) {
            logger.info(`[Gemini IP] Marked fixed IP ${fixedIp} as temporarily unavailable for ${hostname} on model ${model} after ${reason} (${cooldownMs}ms).`);
        }
    }

    _getFixedIpAgent(hostname, fixedIp) {
        const cacheKey = `${hostname}|${fixedIp}`;
        if (!this.fixedIpAgentCache.has(cacheKey)) {
            const agent = new https.Agent({
                keepAlive: true,
                maxSockets: 100,
                maxFreeSockets: 5,
                timeout: 120000,
                lookup: (lookupHostname, options, callback) => {
                    const actualCallback = typeof options === 'function' ? options : callback;
                    const actualOptions = typeof options === 'function' ? undefined : options;

                    if (lookupHostname === hostname) {
                        if (actualOptions?.all) {
                            actualCallback(null, [{ address: fixedIp, family: 4 }]);
                            return;
                        }

                        actualCallback(null, fixedIp, 4);
                        return;
                    }

                    if (actualOptions === undefined) {
                        dns.lookup(lookupHostname, actualCallback);
                        return;
                    }

                    dns.lookup(lookupHostname, actualOptions, actualCallback);
                },
            });

            this.fixedIpAgentCache.set(cacheKey, agent);
        }

        return this.fixedIpAgentCache.get(cacheKey);
    }

    _createFixedIpAttemptOptions(requestOptions, hostname, fixedIp, signal = undefined) {
        return {
            ...requestOptions,
            agent: this._getFixedIpAgent(hostname, fixedIp),
            _geminiFixedIp: fixedIp,
            ...(signal ? { signal } : {}),
        };
    }

    _createChildAbortController(parentSignal) {
        const controller = new AbortController();
        if (!parentSignal) {
            return {
                controller,
                dispose: () => {},
            };
        }

        if (parentSignal.aborted) {
            controller.abort(parentSignal.reason);
            return {
                controller,
                dispose: () => {},
            };
        }

        const forwardAbort = () => {
            controller.abort(parentSignal.reason);
        };
        parentSignal.addEventListener('abort', forwardAbort, { once: true });

        return {
            controller,
            dispose: () => parentSignal.removeEventListener('abort', forwardAbort),
        };
    }

    async _hydrateErrorResponseBody(response) {
        if (!response || response.data === undefined || response.data === null) {
            return response;
        }

        const currentData = response.data;
        if (typeof currentData === 'string') {
            return response;
        }

        const isAsyncIterable = typeof currentData?.[Symbol.asyncIterator] === 'function';
        const isWebStream = typeof currentData?.getReader === 'function';
        if (!isAsyncIterable && !isWebStream) {
            return response;
        }

        let rawBody = '';

        if (isAsyncIterable) {
            for await (const chunk of currentData) {
                if (typeof chunk === 'string') {
                    rawBody += chunk;
                } else {
                    rawBody += Buffer.from(chunk).toString('utf8');
                }
            }
        } else {
            const reader = currentData.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                rawBody += typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
            }
        }

        if (!rawBody) {
            response.data = rawBody;
            return response;
        }

        try {
            response.data = JSON.parse(rawBody);
        } catch {
            response.data = rawBody;
        }

        return response;
    }

    _createFixedIpResponseError(requestOptions, response) {
        const message = extractGeminiErrorText(response?.data) || `Request failed with status code ${response?.status || 'unknown'}`;
        return new GaxiosError(message, requestOptions, response);
    }

    _createFixedIpRaceExhaustedError(requestOptions, hostname, model, rounds) {
        const modelSuffix = model ? ` for model ${model}` : '';
        const response = {
            status: 429,
            data: {
                error: {
                    message: `Fixed IP race exhausted after ${rounds} round(s) for ${hostname}${modelSuffix}.`,
                },
            },
            config: requestOptions,
        };
        return this._createFixedIpResponseError(requestOptions, response);
    }

    async _runFixedIpRaceBatch(requestOptions, defaultAdapter, hostname, model, batchIps, roundNumber, totalRounds) {
        const modelSuffix = model ? ` for model ${model}` : '';
        const attempts = [];

        return new Promise((resolve) => {
            const state = {
                settled: false,
                pending: batchIps.length,
                lastResponseError: null,
                lastTransportError: null,
            };

            const finalize = (result) => {
                if (state.settled) {
                    return;
                }

                state.settled = true;

                for (const attempt of attempts) {
                    attempt.dispose();
                    if (result?.fixedIp && attempt.fixedIp === result.fixedIp) {
                        continue;
                    }
                    if (!attempt.controller.signal.aborted) {
                        attempt.controller.abort(FIXED_IP_RACE_INTERNAL_ABORT);
                    }
                }

                resolve(result);
            };

            const markRetryableComplete = () => {
                if (state.settled) {
                    return;
                }

                state.pending -= 1;
                if (state.pending === 0) {
                    finalize({
                        type: 'retryable',
                        lastResponseError: state.lastResponseError,
                        lastTransportError: state.lastTransportError,
                    });
                }
            };

            const handleFailedResponse = async (response, attemptOptions, fixedIp) => {
                await this._hydrateErrorResponseBody(response);

                const decision = classifyGeminiFixedIpResponse(response);
                const rotateQuotaExhausted = decision.reason === '429-quota-exhausted' &&
                    shouldRotateGeminiQuotaExhaustedFixedIp(model);
                const error = this._createFixedIpResponseError(attemptOptions, response);
                const serverTimingSuffix = response?.status === 429
                    ? formatServerTimingLogSuffix(response?.headers)
                    : '';

                if (decision.reason === '429-no-capacity' && !this.fixedIpRaceDisableCooldown) {
                    this._markFixedIpCooldown(hostname, fixedIp, decision.reason, model);
                }

                if (rotateQuotaExhausted || decision.action === 'rotate') {
                    this._clearPreferredFixedIp(hostname, fixedIp, decision.reason, model);
                    logger.warn(`[Gemini IP] ${hostname}${modelSuffix} race round ${roundNumber}/${totalRounds} failed via fixed IP ${fixedIp} (${decision.reason}, status=${response.status}).${serverTimingSuffix}`);
                    return {
                        type: 'retryable-response',
                        error,
                    };
                }

                if (decision.reason === '429-quota-exhausted') {
                    logger.info(`[Gemini IP] ${hostname}${modelSuffix} fixed IP ${fixedIp} returned quota exhaustion during race round ${roundNumber}/${totalRounds}. Stopping race and falling back to the existing quota handling.${serverTimingSuffix}`);
                } else {
                    logger.warn(`[Gemini IP] ${hostname}${modelSuffix} fixed IP ${fixedIp} returned non-rotatable status ${response.status} (${decision.reason}) during race round ${roundNumber}/${totalRounds}.${serverTimingSuffix}`);
                }

                return {
                    type: 'fatal',
                    error,
                };
            };

            for (const fixedIp of batchIps) {
                const { controller, dispose } = this._createChildAbortController(requestOptions?.signal);
                const attemptOptions = this._createFixedIpAttemptOptions(
                    requestOptions,
                    hostname,
                    fixedIp,
                    controller.signal
                );
                attempts.push({ fixedIp, controller, dispose });

                (async () => {
                    try {
                        const response = await defaultAdapter(attemptOptions);
                        if (state.settled || controller.signal.reason === FIXED_IP_RACE_INTERNAL_ABORT) {
                            return;
                        }

                        if (response.status >= 200 && response.status < 300) {
                            this._rememberSuccessfulFixedIp(hostname, fixedIp, model);
                            if (model) {
                                logger.info(`[Gemini IP] ${hostname} request for model ${model} succeeded via fixed IP ${fixedIp} during race round ${roundNumber}/${totalRounds}.`);
                            } else {
                                logger.info(`[Gemini IP] ${hostname} request succeeded via fixed IP ${fixedIp} during race round ${roundNumber}/${totalRounds}.`);
                            }
                            finalize({
                                type: 'success',
                                response,
                                fixedIp,
                            });
                            return;
                        }

                        const result = await handleFailedResponse(response, attemptOptions, fixedIp);
                        if (result.type === 'retryable-response') {
                            state.lastResponseError = result.error;
                            markRetryableComplete();
                            return;
                        }

                        finalize({
                            type: 'fatal',
                            error: result.error,
                            fixedIp,
                        });
                    } catch (error) {
                        if (controller.signal.reason === FIXED_IP_RACE_INTERNAL_ABORT || state.settled) {
                            return;
                        }

                        if (requestOptions?.signal?.aborted) {
                            finalize({
                                type: 'fatal',
                                error,
                                fixedIp,
                            });
                            return;
                        }

                        if (error instanceof GaxiosError && error.response) {
                            const result = await handleFailedResponse(error.response, attemptOptions, fixedIp);
                            if (result.type === 'retryable-response') {
                                state.lastResponseError = result.error;
                                markRetryableComplete();
                                return;
                            }

                            finalize({
                                type: 'fatal',
                                error: result.error,
                                fixedIp,
                            });
                            return;
                        }

                        const decision = classifyGeminiFixedIpError(error);
                        if (decision.action === 'rotate') {
                            this._clearPreferredFixedIp(hostname, fixedIp, decision.reason, model);
                            logger.warn(`[Gemini IP] ${hostname}${modelSuffix} transport failed via fixed IP ${fixedIp} (${decision.reason}) during race round ${roundNumber}/${totalRounds}.`);
                            state.lastTransportError = error;
                            markRetryableComplete();
                            return;
                        }

                        finalize({
                            type: 'fatal',
                            error,
                            fixedIp,
                        });
                    }
                })();
            }
        });
    }

    async _executeWithConcurrentFixedIpRotation(requestOptions, defaultAdapter) {
        const hostname = extractHostnameFromUrl(requestOptions?.url);
        const model = typeof requestOptions?._geminiModel === 'string' && requestOptions._geminiModel.trim()
            ? requestOptions._geminiModel.trim()
            : null;
        const modelSuffix = model ? ` for model ${model}` : '';
        let lastResponseError = null;
        let lastTransportError = null;

        for (let roundIndex = 0; roundIndex < this.fixedIpRaceRounds; roundIndex++) {
            throwIfAborted(requestOptions?.signal);
            const roundNumber = roundIndex + 1;
            const candidateIps = this._getFixedIpCandidates(hostname, model);
            if (candidateIps.length === 0) {
                logger.info(`[Gemini IP] All fixed IP candidates for ${hostname}${modelSuffix} are currently on cooldown before race round ${roundNumber}/${this.fixedIpRaceRounds}.`);
                break;
            }

            const concurrency = Math.min(this.fixedIpRaceConcurrency, candidateIps.length);
            logger.info(`[Gemini IP] Starting fixed IP race round ${roundNumber}/${this.fixedIpRaceRounds} for ${hostname}${modelSuffix} with ${candidateIps.length} candidate IP(s) and concurrency ${concurrency}.`);

            for (let offset = 0; offset < candidateIps.length; offset += concurrency) {
                const batchIps = candidateIps.slice(offset, offset + concurrency);
                const result = await this._runFixedIpRaceBatch(
                    requestOptions,
                    defaultAdapter,
                    hostname,
                    model,
                    batchIps,
                    roundNumber,
                    this.fixedIpRaceRounds
                );

                if (result.type === 'success') {
                    return result.response;
                }

                if (result.type === 'fatal') {
                    throw result.error;
                }

                if (result.lastResponseError) {
                    lastResponseError = result.lastResponseError;
                }
                if (result.lastTransportError) {
                    lastTransportError = result.lastTransportError;
                }

                const hasNextBatchInRound = offset + concurrency < candidateIps.length;
                const hasNextRound = roundIndex < this.fixedIpRaceRounds - 1;
                if ((hasNextBatchInRound || hasNextRound) && this.fixedIpRaceRequestDelayMs > 0) {
                    logger.info(`[Gemini IP] Waiting ${this.fixedIpRaceRequestDelayMs}ms before the next fixed IP race attempt for ${hostname}${modelSuffix}.`);
                    await waitWithAbort(this.fixedIpRaceRequestDelayMs, requestOptions?.signal);
                }
            }
        }

        if (this.fixedIpRaceFallbackToDns) {
            logger.info(`[Gemini IP] Fixed IP race exhausted for ${hostname}${modelSuffix}. Falling back to default DNS/transport.`);
            return defaultAdapter(requestOptions);
        }

        if (lastResponseError) {
            throw lastResponseError;
        }

        if (lastTransportError) {
            throw lastTransportError;
        }

        throw this._createFixedIpRaceExhaustedError(requestOptions, hostname, model, this.fixedIpRaceRounds);
    }

    async _executeWithSequentialFixedIpRotation(requestOptions, defaultAdapter) {
        if (!this._shouldUseFixedIpRotation(requestOptions?.url)) {
            return defaultAdapter(requestOptions);
        }

        const hostname = extractHostnameFromUrl(requestOptions?.url);
        const model = typeof requestOptions?._geminiModel === 'string' && requestOptions._geminiModel.trim()
            ? requestOptions._geminiModel.trim()
            : null;
        const candidateIps = this._getFixedIpCandidates(hostname, model);
        if (candidateIps.length === 0) {
            const modelSuffix = model ? ` for model ${model}` : '';
            logger.info(`[Gemini IP] All fixed IP candidates for ${hostname}${modelSuffix} are currently on cooldown. Falling back to default DNS/transport.`);
            return defaultAdapter(requestOptions);
        }

        let lastResponseError = null;
        let lastTransportError = null;

        for (let attemptIndex = 0; attemptIndex < candidateIps.length; attemptIndex++) {
            const fixedIp = candidateIps[attemptIndex];
            const attemptOptions = this._createFixedIpAttemptOptions(requestOptions, hostname, fixedIp);

            try {
                const response = await defaultAdapter(attemptOptions);

                if (response.status >= 200 && response.status < 300) {
                    this._rememberSuccessfulFixedIp(hostname, fixedIp, model);
                    if (model) {
                        logger.info(`[Gemini IP] ${hostname} request for model ${model} succeeded via fixed IP ${fixedIp}.`);
                    } else {
                        logger.info(`[Gemini IP] ${hostname} request succeeded via fixed IP ${fixedIp}.`);
                    }
                    return response;
                }

                await this._hydrateErrorResponseBody(response);
                const decision = classifyGeminiFixedIpResponse(response);
                const hasNextIp = attemptIndex < candidateIps.length - 1;
                const rotateQuotaExhausted = decision.reason === '429-quota-exhausted' &&
                    hasNextIp &&
                    shouldRotateGeminiQuotaExhaustedFixedIp(model);
                const serverTimingSuffix = response?.status === 429
                    ? formatServerTimingLogSuffix(response?.headers)
                    : '';

                if (decision.reason === '429-no-capacity') {
                    this._markFixedIpCooldown(hostname, fixedIp, decision.reason, model);
                }

                if (rotateQuotaExhausted) {
                    this._clearPreferredFixedIp(hostname, fixedIp, decision.reason, model);
                    logger.warn(`[Gemini IP] ${hostname} fixed IP ${fixedIp} returned quota exhaustion for model ${model}. Trying the next fixed IP (${attemptIndex + 2}/${candidateIps.length}) before falling back to the project's retry/quota handling.${serverTimingSuffix}`);
                    lastResponseError = this._createFixedIpResponseError(attemptOptions, response);
                    continue;
                }

                if (decision.action === 'rotate' && hasNextIp) {
                    this._clearPreferredFixedIp(hostname, fixedIp, decision.reason, model);
                    const modelSuffix = model ? ` for model ${model}` : '';
                    logger.warn(`[Gemini IP] ${hostname}${modelSuffix} returned ${response.status} via fixed IP ${fixedIp} (${decision.reason}). Switching to next fixed IP (${attemptIndex + 2}/${candidateIps.length}).${serverTimingSuffix}`);
                    lastResponseError = this._createFixedIpResponseError(attemptOptions, response);
                    continue;
                }

                if (decision.reason === '429-quota-exhausted') {
                    const modelSuffix = model ? ` for model ${model}` : '';
                    logger.info(`[Gemini IP] ${hostname}${modelSuffix} fixed IP ${fixedIp} returned quota exhaustion. Falling back to the project's existing retry/quota handling.${serverTimingSuffix}`);
                } else if (decision.action === 'rotate') {
                    const modelSuffix = model ? ` for model ${model}` : '';
                    logger.warn(`[Gemini IP] ${hostname}${modelSuffix} still returned ${response.status} via fixed IP ${fixedIp} after exhausting fixed IP candidates.${serverTimingSuffix}`);
                }

                throw this._createFixedIpResponseError(attemptOptions, response);
            } catch (error) {
                if (error instanceof GaxiosError && error.response) {
                    throw error;
                }

                const decision = classifyGeminiFixedIpError(error);
                const hasNextIp = attemptIndex < candidateIps.length - 1;

                if (decision.action === 'rotate' && hasNextIp) {
                    this._clearPreferredFixedIp(hostname, fixedIp, decision.reason, model);
                    const modelSuffix = model ? ` for model ${model}` : '';
                    logger.warn(`[Gemini IP] ${hostname}${modelSuffix} transport failed via fixed IP ${fixedIp} (${decision.reason}). Switching to next fixed IP (${attemptIndex + 2}/${candidateIps.length}).`);
                    lastTransportError = error;
                    continue;
                }

                if (decision.action === 'rotate') {
                    const modelSuffix = model ? ` for model ${model}` : '';
                    logger.warn(`[Gemini IP] ${hostname}${modelSuffix} transport still failed via fixed IP ${fixedIp} (${decision.reason}) and no fixed IP candidates remain.`);
                }

                throw error;
            }
        }

        if (lastResponseError) {
            throw lastResponseError;
        }

        if (lastTransportError) {
            throw lastTransportError;
        }

        return defaultAdapter(requestOptions);
    }

    async _executeWithFixedIpRotation(requestOptions, defaultAdapter) {
        if (!this._shouldUseFixedIpRotation(requestOptions?.url)) {
            return defaultAdapter(requestOptions);
        }

        if (this.fixedIpRaceEnabled) {
            return this._executeWithConcurrentFixedIpRotation(requestOptions, defaultAdapter);
        }

        return this._executeWithSequentialFixedIpRotation(requestOptions, defaultAdapter);
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Gemini] Initializing Gemini API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        if (!this.projectId) {
            if (!this.authClient.credentials.access_token && this.authClient.credentials.refresh_token) {
                logger.info('[Gemini Auth] Access token is missing before project discovery. Refreshing from stored refresh token...');
                await this.initializeAuth(false);
            }

            if (!this.authClient.credentials.access_token && !this.authClient.credentials.refresh_token) {
                throw new Error('Could not discover a valid Google Cloud Project ID because no Gemini OAuth credentials were loaded. Configure PROJECT_ID explicitly or provide valid OAuth credentials.');
            }

            this.projectId = await this.discoverProjectAndModels();
        } else {
            logger.info(`[Gemini] Using provided Project ID: ${this.projectId}`);
            this.availableModels = GEMINI_MODELS;
            logger.info(`[Gemini] Using fixed models: [${this.availableModels.join(', ')}]`);
        }
        if (this.projectId === 'default') {
            throw new Error("Error: 'default' is not a valid project ID. Please provide a valid Google Cloud Project ID using the --project-id argument.");
        }
        this.isInitialized = true;
        logger.info(`[Gemini] Initialization complete. Project ID: ${this.projectId}`);
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        if (this.oauthCredsBase64) {
            try {
                const decoded = Buffer.from(this.oauthCredsBase64, 'base64').toString('utf8');
                const credentials = JSON.parse(decoded);
                this.authClient.setCredentials(credentials);
                logger.info('[Gemini Auth] Credentials loaded successfully from base64 string.');
                return;
            } catch (error) {
                logger.error('[Gemini Auth] Failed to parse base64 OAuth credentials:', error);
            }
        }

        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
        try {
            const data = await fs.readFile(credPath, "utf8");
            const credentials = JSON.parse(data);
            this.authClient.setCredentials(credentials);
            logger.info('[Gemini Auth] Credentials loaded successfully from file.');
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.debug(`[Gemini Auth] Credentials file not found: ${credPath}`);
            } else {
                logger.warn(`[Gemini Auth] Failed to load credentials from file: ${error.message}`);
            }
        }
    }

    async initializeAuth(forceRefresh = false) {
        // 检查是否需要刷新 Token
        const needsRefresh = forceRefresh

        if (this.authClient.credentials.access_token && !needsRefresh) {
            // Token 有效且不需要刷新
            return;
        }

        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 只有在明确要求刷新，或者 AccessToken 确实缺失时，才执行刷新/认证
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (needsRefresh || !this.authClient.credentials.access_token) {
            const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
            try {
                if (this.authClient.credentials.refresh_token) {
                    logger.info('[Gemini Auth] Token expiring soon or force refresh requested. Refreshing token...');
                    const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                    this.authClient.setCredentials(newCredentials);
                    
                    // 如果不是从 base64 加载的，则保存到文件
                    if (!this.oauthCredsBase64) {
                        await this._saveCredentialsToFile(credPath, newCredentials);
                        logger.info('[Gemini Auth] Token refreshed and saved successfully.');
                    } else {
                        logger.info('[Gemini Auth] Token refreshed successfully (Base64 source).');
                    }

                    // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.GEMINI_CLI, this.uuid);
                    }
                } else {
                    logger.info(`[Gemini Auth] No access token or refresh token. Starting new authentication flow...`);
                    const newTokens = await this.getNewToken(credPath);
                    this.authClient.setCredentials(newTokens);
                    logger.info('[Gemini Auth] New token obtained and loaded into memory.');
                    
                    // 认证成功，重置状态
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.GEMINI_CLI, this.uuid);
                    }
                }
            } catch (error) {
                logger.error('[Gemini Auth] Failed to initialize authentication:', error);
                throw new Error(`Failed to load OAuth credentials.`);
            }
        }
    }

    async getNewToken(credPath) {
        // 使用统一的 OAuth 处理方法
        const { authUrl, authInfo } = await handleGeminiCliOAuth(this.config, { credPath });
        
        logger.info('\n[Gemini Auth] 正在自动打开浏览器进行授权...');
        logger.info('[Gemini Auth] 授权链接:', authUrl, '\n');

        // 自动打开浏览器
        const showFallbackMessage = () => {
            logger.info('[Gemini Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开');
        };

        if (this.config) {
            try {
                const childProcess = await open(authUrl);
                if (childProcess) {
                    childProcess.on('error', () => showFallbackMessage());
                }
            } catch (_err) {
                showFallbackMessage();
            }
        } else {
            showFallbackMessage();
        }

        // 等待 OAuth 回调完成并读取保存的凭据
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const data = await fs.readFile(credPath, 'utf8');
                    const credentials = JSON.parse(data);
                    if (credentials.access_token) {
                        clearInterval(checkInterval);
                        logger.info('[Gemini Auth] New token obtained successfully.');
                        resolve(credentials);
                    }
                } catch (error) {
                    // 文件尚未创建或无效，继续等待
                }
            }, 1000);

            // 设置超时（5分钟）
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('[Gemini Auth] OAuth 授权超时'));
            }, 5 * 60 * 1000);
        });
    }

    async discoverProjectAndModels() {
        if (this.projectId) {
            logger.info(`[Gemini] Using pre-configured Project ID: ${this.projectId}`);
            return this.projectId;
        }

        logger.info('[Gemini] Discovering Project ID...');
        this.availableModels = GEMINI_MODELS;
        logger.info(`[Gemini] Using fixed models: [${this.availableModels.join(', ')}]`);
        try {
            const initialProjectId = ""
            // Prepare client metadata
            const clientMetadata = {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
                duetProject: initialProjectId,
            }

            // Call loadCodeAssist to discover the actual project ID
            const loadRequest = {
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            }

            const loadResponse = await this.callApi('loadCodeAssist', loadRequest);

            // Check if we already have a project ID from the response
            if (loadResponse.cloudaicompanionProject) {
                return loadResponse.cloudaicompanionProject;
            }

            // If no existing project, we need to onboard
            const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || 'free-tier';

            const onboardRequest = {
                tierId: tierId,
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            let lroResponse = await this.callApi('onboardUser', onboardRequest);

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30; // Maximum number of retries (60 seconds total)
            let retryCount = 0;

            while (!lroResponse.done && retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                lroResponse = await this.callApi('onboardUser', onboardRequest);
                retryCount++;
            }

            if (!lroResponse.done) {
                throw new Error('Onboarding timeout: Operation did not complete within expected time.');
            }

            const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
            return discoveredProjectId;
        } catch (error) {
            logger.error('[Gemini] Failed to discover Project ID:', error.response?.data || error.message);
            throw new Error('Could not discover a valid Google Cloud Project ID.');
        }
    }

    async listModels() {
        if (!this.isInitialized) await this.initialize();
        const formattedModels = this.availableModels.map(modelId => {
            const displayName = modelId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            return {
                name: `models/${modelId}`, version: "1.0.0", displayName: displayName,
                description: `A generative model for text and chat generation. ID: ${modelId}`,
                inputTokenLimit: 1024000, outputTokenLimit: 65535,
                supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
            };
        });
        return { models: formattedModels };
    }

    async callApi(method, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || DEFAULT_REQUEST_MAX_RETRIES;
        const transientMaxRetries = Math.min(maxRetries, MAX_TRANSIENT_ERROR_RETRIES);
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            if (body?.model) {
                logger.info(`[Gemini API] Dispatch ${method} | model=${body.model} | project=${body.project || this.projectId || 'unknown'}`);
            }

            const requestOptions = {
                url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": buildGeminiCliUserAgent(this.config.GEMINI_USER_AGENT, body?.model),
                },
                responseType: "json",
                body: JSON.stringify(body),
                _geminiModel: body?.model,
            };
            const res = await this.authClient.request(requestOptions);
            return res.data;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const errorDetails = error.response?.data;
            const serverTimingSuffix = status === 429
                ? formatServerTimingLogSuffix(error?.response?.headers)
                : '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            logger.error(`[Gemini API] Error calling (Status: ${status}, Code: ${errorCode})${serverTimingSuffix}:`, errorMessage);
            if (errorDetails) {
                try {
                    logger.error(`[Gemini API] Upstream error details: ${JSON.stringify(errorDetails)}`);
                } catch (_e) {
                    logger.error(`[Gemini API] Upstream error details (raw): ${String(errorDetails)}`);
                }
            }

            // Handle authentication failures - mark for background refresh and switch credential
            if (isAuthFailureResponse(status, error) && !isRetry) {
                logger.info(`[Gemini API] Received auth error (status: ${status}). Triggering background refresh via PoolManager...`);
                
                // 标记当前凭证为不健康（会自动进入刷新队列）
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[Gemini] Marking credential ${this.uuid} as needs refresh. Reason: auth error status ${status}`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (status === 429 && retryCount < maxRetries) {
                const quotaRetryDelayHintMs = getQuotaRetryDelayHintMs(error);
                const delay = computeQuotaRetryDelayMs(baseDelay, retryCount, quotaRetryDelayHintMs);
                const hintLog = quotaRetryDelayHintMs !== null ? ` (server hint >= ${Math.round(quotaRetryDelayHintMs)}ms)` : '';
                logger.info(`[Gemini API] Received 429 (Too Many Requests). Retrying in ${delay}ms${hintLog}... (attempt ${retryCount + 1}/${maxRetries})${serverTimingSuffix}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < transientMaxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Gemini API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${transientMaxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < transientMaxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Gemini API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${transientMaxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            if (status === 429) {
                const quotaRecoveryDelayMs = getQuotaRetryDelayHintMs(error);
                if (Number.isFinite(quotaRecoveryDelayMs) && quotaRecoveryDelayMs > 0) {
                    error.quotaRecoveryDelayMs = quotaRecoveryDelayMs;
                }
            }

            if ((status >= 500 && status < 600) || isNetworkError) {
                // Avoid a second retry wave at pool-switch layer for transient upstream failures.
                error.skipCredentialSwitch = true;
            }

            throw error;
        }
    }

    async * streamApi(method, body, isRetry = false, retryCount = 0, signal = undefined) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || DEFAULT_REQUEST_MAX_RETRIES;
        const transientMaxRetries = Math.min(maxRetries, MAX_TRANSIENT_ERROR_RETRIES);
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            throwIfAborted(signal);

            if (body?.model) {
                logger.info(`[Gemini API] Dispatch ${method} (stream) | model=${body.model} | project=${body.project || this.projectId || 'unknown'}`);
            }

            const requestOptions = {
                url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
                method: "POST",
                params: { alt: "sse" },
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": buildGeminiCliUserAgent(this.config.GEMINI_USER_AGENT, body?.model),
                },
                responseType: "stream",
                body: JSON.stringify(body),
                _geminiModel: body?.model,
                ...(signal ? { signal } : {}),
            };
            const res = await this.authClient.request(requestOptions);
            if (res.status !== 200) {
                let errorBody = '';
                for await (const chunk of res.data) errorBody += chunk.toString();
                throw new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
            }
            yield* this.parseSSEStream(res.data);
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const errorDetails = error.response?.data;
            const serverTimingSuffix = status === 429
                ? formatServerTimingLogSuffix(error?.response?.headers)
                : '';
            
            if (signal?.aborted || isRetryableAbortError(error)) {
                throw error;
            }

            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            logger.error(`[Gemini API] Error during stream (Status: ${status}, Code: ${errorCode})${serverTimingSuffix}:`, errorMessage);
            if (errorDetails) {
                try {
                    logger.error(`[Gemini API] Upstream stream error details: ${JSON.stringify(errorDetails)}`);
                } catch (_e) {
                    logger.error(`[Gemini API] Upstream stream error details (raw): ${String(errorDetails)}`);
                }
            }

            // Handle authentication failures - mark for background refresh and switch credential
            if (isAuthFailureResponse(status, error) && !isRetry) {
                logger.info(`[Gemini API] Received auth error during stream (status: ${status}). Triggering background refresh via PoolManager...`);
                
                // 标记当前凭证为不健康（会自动进入刷新队列）
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[Gemini] Marking credential ${this.uuid} as needs refresh. Reason: auth error status ${status} in stream`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (status === 429 && retryCount < maxRetries) {
                const quotaRetryDelayHintMs = getQuotaRetryDelayHintMs(error);
                const delay = computeQuotaRetryDelayMs(baseDelay, retryCount, quotaRetryDelayHintMs);
                const hintLog = quotaRetryDelayHintMs !== null ? ` (server hint >= ${Math.round(quotaRetryDelayHintMs)}ms)` : '';
                logger.info(`[Gemini API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms${hintLog}... (attempt ${retryCount + 1}/${maxRetries})${serverTimingSuffix}`);
                await waitWithAbort(delay, signal);
                yield* this.streamApi(method, body, isRetry, retryCount + 1, signal);
                return;
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < transientMaxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Gemini API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${transientMaxRetries})`);
                await waitWithAbort(delay, signal);
                yield* this.streamApi(method, body, isRetry, retryCount + 1, signal);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < transientMaxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Gemini API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${transientMaxRetries})`);
                await waitWithAbort(delay, signal);
                yield* this.streamApi(method, body, isRetry, retryCount + 1, signal);
                return;
            }

            if (status === 429) {
                const quotaRecoveryDelayMs = getQuotaRetryDelayHintMs(error);
                if (Number.isFinite(quotaRecoveryDelayMs) && quotaRecoveryDelayMs > 0) {
                    error.quotaRecoveryDelayMs = quotaRecoveryDelayMs;
                }
            }

            if ((status >= 500 && status < 600) || isNetworkError) {
                // Avoid a second retry wave at pool-switch layer for transient upstream failures.
                error.skipCredentialSwitch = true;
            }

            throw error;
        }
    }

    async * parseSSEStream(stream) {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let buffer = [];
        for await (const line of rl) {
            if (line.startsWith("data: ")) buffer.push(line.slice(6));
            else if (line === "" && buffer.length > 0) {
                try { yield JSON.parse(buffer.join('\n')); } catch (e) { logger.error("[Stream] Failed to parse JSON chunk:", buffer.join('\n')); }
                buffer = [];
            }
        }
        if (buffer.length > 0) {
            try { yield JSON.parse(buffer.join('\n')); } catch (e) { logger.error("[Stream] Failed to parse final JSON chunk:", buffer.join('\n')); }
        }
    }

    async generateContent(model, requestBody) {
        logger.info(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        let monitorRequestId = null;
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            monitorRequestId = requestBody._monitorRequestId;
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Gemini] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
                    uuid: this.uuid
                });
            }
        }
        
        const selectedModel = resolve_gemini_model(model);
        if (selectedModel !== model) {
            logger.info(`[Gemini] Model normalized: '${model}' -> '${selectedModel}'`);
        }
        const processedRequestBody = ensureRolesInContents(requestBody);
        ensureGeminiSessionId(processedRequestBody);
        const apiRequest = { model: selectedModel, project: this.projectId, request: processedRequestBody };
        const response = await this.callApi(API_ACTIONS.GENERATE_CONTENT, apiRequest);
        return toGeminiApiResponse(response.response);
    }

    async * generateContentStream(model, requestBody, options = {}) {
        logger.info(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
        const signal = options?.signal;

        throwIfAborted(signal);

        let monitorRequestId = null;
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            monitorRequestId = requestBody._monitorRequestId;
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Gemini] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
                    uuid: this.uuid
                });
            }
        }

        // 检查是否为防截断模型
        if (is_anti_truncation_model(model)) {
            // 从防截断模型名中提取实际模型名
            const actualModel = extract_model_from_anti_model(model);
            if (!isProviderModelSupported(MODEL_PROVIDER.GEMINI_CLI, actualModel)) {
                throw createUnsupportedModelError(model, `anti-${actualModel}`);
            }
            // 使用防截断流处理
            const processedRequestBody = ensureRolesInContents(requestBody);
            ensureGeminiSessionId(processedRequestBody);
            yield* apply_anti_truncation_to_stream(this, actualModel, processedRequestBody, signal);
        } else {
            if (typeof model === 'string' && model.startsWith('anti-')) {
                const normalizedBaseModel = normalizeProviderModel(MODEL_PROVIDER.GEMINI_CLI, model.substring(5));
                throw createUnsupportedModelError(model, `anti-${normalizedBaseModel}`);
            }

            // 正常流处理
            const selectedModel = resolve_gemini_model(model);
            if (selectedModel !== model) {
                logger.info(`[Gemini] Model normalized: '${model}' -> '${selectedModel}'`);
            }
            const processedRequestBody = ensureRolesInContents(requestBody);
            ensureGeminiSessionId(processedRequestBody);
            const apiRequest = this._buildCodeAssistGenerateRequest(selectedModel, processedRequestBody, monitorRequestId);
            const stream = this.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest, false, 0, signal);
            for await (const chunk of stream) {
                yield toGeminiApiResponse(chunk.response);
            }
        }
    }

     /**
     * Checks if the given expiry date is within the next 10 minutes from now.
     * @returns {boolean} True if the expiry date is within the next 10 minutes, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const nearMinutes = 20;
            const { message, isNearExpiry } = formatExpiryLog('Gemini', this.authClient.credentials.expiry_date, nearMinutes);
            logger.info(message);
            return isNearExpiry;
        } catch (error) {
            logger.error(`[Gemini] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 保存凭证到文件
     * @param {string} filePath - 凭证文件路径
     * @param {Object} credentials - 凭证数据
     */
    async _saveCredentialsToFile(filePath, credentials) {
        try {
            await fs.writeFile(filePath, JSON.stringify(credentials, null, 2));
            logger.info(`[Gemini Auth] Credentials saved to ${filePath}`);
        } catch (error) {
            logger.error(`[Gemini Auth] Failed to save credentials to ${filePath}: ${error.message}`);
            throw error;
        }
    }

    /**
     * 获取模型配额信息
     * @returns {Promise<Object>} 模型配额信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        
        // 注意：V2 架构下不再在 getUsageLimits 中同步刷新 token
        // 如果 token 过期，PoolManager 后台会自动处理
        // if (this.isExpiryDateNear()) {
        //     logger.info('[Gemini] Token is near expiry, refreshing before getUsageLimits request...');
        //     await this.initializeAuth(true);
        // }

        try {
            const modelsWithQuotas = await this.getModelsWithQuotas();
            return modelsWithQuotas;
        } catch (error) {
            logger.error('[Gemini] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 获取带配额信息的模型列表
     * @returns {Promise<Object>} 模型配额信息
     */
    async getModelsWithQuotas() {
        try {
            // 解析模型配额信息
            const result = {
                lastUpdated: Date.now(),
                models: {}
            };

            // 调用 retrieveUserQuota 接口获取用户配额信息
            try {
                const quotaURL = `${this.codeAssistEndpoint}/${this.apiVersion}:retrieveUserQuota`;
                const requestBody = {
                    project: `${this.projectId}`
                };
                const requestOptions = {
                    url: quotaURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    responseType: 'json',
                    body: JSON.stringify(requestBody)
                };

                const res = await this.authClient.request(requestOptions);
                // logger.info(`[Gemini] retrieveUserQuota success`, JSON.stringify(res.data));
                if (res.data && res.data.buckets) {
                    const buckets = res.data.buckets;
                    
                    // 遍历 buckets 数组，提取配额信息
                    for (const bucket of buckets) {
                        const modelId = bucket.modelId;
                        
                        // 检查模型是否在支持的模型列表中
                        if (!GEMINI_MODELS.includes(modelId)) continue;
                        
                        const modelInfo = {
                            remaining: bucket.remainingFraction || 0,
                            resetTime: bucket.resetTime || null,
                            resetTimeRaw: bucket.resetTime
                        };
                        
                        result.models[modelId] = modelInfo;
                    }

                    // 对模型按名称排序
                    const sortedModels = {};
                    Object.keys(result.models).sort().forEach(key => {
                        sortedModels[key] = result.models[key];
                    });
                    result.models = sortedModels;
                    // logger.info(`[Gemini] Sorted Models:`, sortedModels);
                    logger.info(`[Gemini] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
                }
            } catch (fetchError) {
                logger.error(`[Gemini] Failed to fetch user quota:`, fetchError.message);
                
                // 如果 retrieveUserQuota 失败，回退到使用固定模型列表
                for (const modelId of GEMINI_MODELS) {
                    result.models[modelId] = {
                        remaining: 0,
                        resetTime: null,
                        resetTimeRaw: null
                    };
                }
            }

            return result;
        } catch (error) {
            logger.error('[Gemini] Failed to get models with quotas:', error.message);
            throw error;
        }
    }
}

