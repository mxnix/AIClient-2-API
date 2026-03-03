import 'dotenv/config';
import path from 'path';
import dns from 'dns';
import https from 'https';
import axios from 'axios';
import { promises as fs } from 'fs';
import { OAuth2Client } from 'google-auth-library';
import { loadMonitorConfig } from './config.js';
import {
    IP_STATUS,
    MANUAL_REFRESH_CALLBACK_DATA,
    STATUS_IMAGE_FILENAMES,
    buildCaption,
    buildRefreshReplyMarkup,
    classifyGeminiProbeResult,
    computeOverallStatus,
    extractErrorText,
    formatCooldownDuration,
    formatMoscowTimestamp,
    getManualRefreshCooldownMs,
    resolveStatusImagePath,
} from './monitor-utils.js';

function log(level, message, extra = null) {
    const timestamp = new Date().toISOString();
    const suffix = extra === null ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    console.log(`[${timestamp}] [${level}] ${message}${suffix}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDirectoryExists(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function loadJsonState(filePath) {
    try {
        const rawContent = await fs.readFile(filePath, 'utf8');
        return JSON.parse(rawContent);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

async function saveJsonState(filePath, state) {
    await ensureDirectoryExists(filePath);
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function cloneJsonCompatibleState(state) {
    return JSON.parse(JSON.stringify(state));
}

function createStatePersister(filePath, state) {
    let pendingSave = Promise.resolve();

    return async function persistState() {
        const snapshot = cloneJsonCompatibleState(state);
        pendingSave = pendingSave
            .catch(() => {})
            .then(() => saveJsonState(filePath, snapshot));
        return pendingSave;
    };
}

function normalizeTimestamp(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function normalizeUserCooldowns(rawValue) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        return {};
    }

    const normalized = {};
    for (const [userId, timestamp] of Object.entries(rawValue)) {
        const normalizedTimestamp = normalizeTimestamp(timestamp);
        if (normalizedTimestamp !== null) {
            normalized[userId] = normalizedTimestamp;
        }
    }

    return normalized;
}

function pruneExpiredUserCooldowns(state, userCooldownMs, nowMs = Date.now()) {
    if (!state?.userCooldowns || typeof state.userCooldowns !== 'object') {
        state.userCooldowns = {};
        return;
    }

    if (!Number.isFinite(userCooldownMs) || userCooldownMs <= 0) {
        state.userCooldowns = {};
        return;
    }

    for (const [userId, timestamp] of Object.entries(state.userCooldowns)) {
        if (!Number.isFinite(timestamp) || nowMs - timestamp >= userCooldownMs) {
            delete state.userCooldowns[userId];
        }
    }
}

async function assertAssetsExist(config) {
    for (const imageName of Object.values(STATUS_IMAGE_FILENAMES)) {
        const imagePath = path.join(config.assetsDir, imageName);
        await fs.access(imagePath);
    }
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

function headersToObject(headers) {
    if (!headers) {
        return {};
    }

    if (typeof headers.entries === 'function') {
        return Object.fromEntries(headers.entries());
    }

    return { ...headers };
}

function shortenErrorText(value, maxLength = 240) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return '';
    }

    return text.length > maxLength
        ? `${text.slice(0, maxLength - 3)}...`
        : text;
}

function formatAuditLine(checkedAtIso, result) {
    const parts = [
        checkedAtIso,
        result.ip,
        result.status,
        result.detail || '',
    ];

    if (result.httpStatus !== null && result.httpStatus !== undefined) {
        parts.push(`http=${result.httpStatus}`);
    }

    if (result.status !== IP_STATUS.WORKING) {
        const shortErrorText = shortenErrorText(result.errorText, 180);
        if (shortErrorText) {
            parts.push(shortErrorText);
        }
    }

    return parts.join(' | ');
}

function formatSummaryAuditLine(checkedAtIso, summary) {
    const counts = summary.counts || {};
    return [
        checkedAtIso,
        'summary',
        summary.overallStatus,
        `working=${counts.working || 0}`,
        `down=${counts.down || 0}`,
        `unknown=${counts.unknown || 0}`,
    ].join(' | ');
}

async function appendAuditLog(filePath, checkedAtIso, summary) {
    const lines = [
        formatSummaryAuditLine(checkedAtIso, summary),
        ...summary.results.map((result) => formatAuditLine(checkedAtIso, result)),
        '',
    ];

    await ensureDirectoryExists(filePath);
    await fs.appendFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

class GeminiIpProbeClient {
    constructor(config) {
        this.config = config;
        this.geminiConfig = config.gemini;
        this.authClient = new OAuth2Client({
            clientId: this.geminiConfig.oauthClientId,
            clientSecret: this.geminiConfig.oauthClientSecret,
        });
        this.projectId = this.geminiConfig.projectId || null;
        this.credentialsLoaded = false;
        this.agentCache = new Map();
    }

    async initialize() {
        await this.loadCredentials();
        if (!this.projectId) {
            this.projectId = await this.discoverProjectId();
        }
    }

    async loadCredentials() {
        if (this.credentialsLoaded) {
            return;
        }

        if (this.geminiConfig.oauthCredsBase64) {
            const decoded = Buffer.from(this.geminiConfig.oauthCredsBase64, 'base64').toString('utf8');
            this.authClient.setCredentials(JSON.parse(decoded));
            this.credentialsLoaded = true;
            return;
        }

        if (!this.geminiConfig.oauthCredsFilePath) {
            throw new Error('GEMINI_OAUTH_CREDS_FILE_PATH is not configured.');
        }

        const rawContent = await fs.readFile(this.geminiConfig.oauthCredsFilePath, 'utf8');
        this.authClient.setCredentials(JSON.parse(rawContent));
        this.credentialsLoaded = true;
    }

    getFixedIpAgent(hostname, fixedIp) {
        const cacheKey = `${hostname}|${fixedIp}`;
        if (!this.agentCache.has(cacheKey)) {
            const agent = new https.Agent({
                keepAlive: true,
                timeout: this.config.probeTimeoutMs,
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

            this.agentCache.set(cacheKey, agent);
        }

        return this.agentCache.get(cacheKey);
    }

    buildEndpointUrl(methodName) {
        return `${this.geminiConfig.baseUrl}/${this.geminiConfig.apiVersion}:${methodName}`;
    }

    async postToGemini(methodName, payload, fixedIp = null) {
        await this.loadCredentials();

        const endpointUrl = this.buildEndpointUrl(methodName);
        const endpointHostname = new URL(endpointUrl).hostname;
        const authHeaders = await this.authClient.getRequestHeaders(endpointUrl);
        const headers = headersToObject(authHeaders);

        const response = await axios({
            url: endpointUrl,
            method: 'POST',
            data: payload,
            headers: {
                ...headers,
                'Content-Type': 'application/json',
            },
            timeout: this.config.probeTimeoutMs,
            httpsAgent: fixedIp ? this.getFixedIpAgent(endpointHostname, fixedIp) : undefined,
            validateStatus: () => true,
        });

        return response;
    }

    async discoverProjectId() {
        const candidateIps = this.geminiConfig.fixedIps.length > 0
            ? [...this.geminiConfig.fixedIps, null]
            : [null];

        const clientMetadata = {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
            duetProject: '',
        };

        for (const candidateIp of candidateIps) {
            try {
                const loadResponse = await this.postToGemini('loadCodeAssist', {
                    cloudaicompanionProject: '',
                    metadata: clientMetadata,
                }, candidateIp);

                if (loadResponse.status < 200 || loadResponse.status >= 300) {
                    throw new Error(`loadCodeAssist failed with status ${loadResponse.status}: ${extractErrorText(loadResponse.data)}`);
                }

                if (loadResponse.data?.cloudaicompanionProject) {
                    return loadResponse.data.cloudaicompanionProject;
                }

                const defaultTier = loadResponse.data?.allowedTiers?.find((tier) => tier?.isDefault);
                const onboardRequest = {
                    tierId: defaultTier?.id || 'free-tier',
                    cloudaicompanionProject: '',
                    metadata: clientMetadata,
                };

                for (let attempt = 0; attempt < 30; attempt += 1) {
                    const onboardResponse = await this.postToGemini('onboardUser', onboardRequest, candidateIp);
                    if (onboardResponse.status < 200 || onboardResponse.status >= 300) {
                        throw new Error(`onboardUser failed with status ${onboardResponse.status}: ${extractErrorText(onboardResponse.data)}`);
                    }

                    if (onboardResponse.data?.done) {
                        const discoveredProjectId = onboardResponse.data?.response?.cloudaicompanionProject?.id;
                        if (discoveredProjectId) {
                            return discoveredProjectId;
                        }
                        break;
                    }

                    await sleep(2000);
                }
            } catch (error) {
                const candidateLabel = candidateIp || 'default DNS';
                log('warn', `Failed to discover PROJECT_ID via ${candidateLabel}.`, extractErrorText(error?.response?.data || error?.message));
            }
        }

        throw new Error('Could not discover a valid Gemini PROJECT_ID. Set PROJECT_ID explicitly.');
    }

    async probeIp(ip) {
        const payload = {
            model: this.geminiConfig.checkModel,
            project: this.projectId,
            request: {
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: 'Reply with a single word: pong.',
                            },
                        ],
                    },
                ],
                generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 8,
                },
            },
        };

        try {
            const response = await this.postToGemini('generateContent', payload, ip);
            const classification = classifyGeminiProbeResult({
                status: response.status,
                data: response.data,
            });

            const result = {
                ip,
                status: classification.status,
                detail: classification.detail,
                httpStatus: response.status,
                errorText: classification.errorText,
            };

            if (classification.status !== IP_STATUS.WORKING) {
                log('warn', `Gemini probe ${ip} -> ${classification.status}.`, {
                    detail: classification.detail,
                    httpStatus: response.status,
                    errorText: shortenErrorText(classification.errorText),
                });
            }

            return result;
        } catch (error) {
            const result = {
                ip,
                status: IP_STATUS.UNKNOWN,
                detail: error?.code || 'request-error',
                httpStatus: error?.response?.status || null,
                errorText: extractErrorText(error?.response?.data || error?.message),
            };

            log('warn', `Gemini probe ${ip} -> unknown.`, {
                detail: result.detail,
                httpStatus: result.httpStatus,
                errorText: shortenErrorText(result.errorText),
            });

            return result;
        }
    }
}

class TelegramApiError extends Error {
    constructor(message, payload = {}) {
        super(message);
        this.name = 'TelegramApiError';
        this.description = payload.description || null;
        this.errorCode = payload.error_code || null;
        this.parameters = payload.parameters || null;
    }
}

class TelegramStatusPublisher {
    constructor(config) {
        this.config = config;
        this.telegramConfig = config.telegram;
        this.refreshReplyMarkup = config.manualRefresh.enabled
            ? buildRefreshReplyMarkup()
            : null;
    }

    buildApiUrl(methodName) {
        return `https://api.telegram.org/bot${this.telegramConfig.botToken}/${methodName}`;
    }

    async callTelegram(methodName, body, headers = undefined) {
        const response = await fetch(this.buildApiUrl(methodName), {
            method: 'POST',
            headers,
            body,
        });

        const payload = await response.json();
        if (!payload.ok) {
            throw new TelegramApiError(payload.description || `${methodName} failed.`, payload);
        }

        return payload.result;
    }

    async callTelegramJson(methodName, payload) {
        return this.callTelegram(
            methodName,
            JSON.stringify(payload),
            { 'Content-Type': 'application/json' }
        );
    }

    async createPngBlob(imagePath) {
        const buffer = await fs.readFile(imagePath);
        return new Blob([buffer], { type: 'image/png' });
    }

    appendRefreshReplyMarkup(target) {
        if (!this.refreshReplyMarkup) {
            return;
        }

        target.append('reply_markup', JSON.stringify(this.refreshReplyMarkup));
    }

    async sendPhotoMessage(caption, imagePath) {
        const formData = new FormData();
        formData.append('chat_id', this.telegramConfig.chatId);
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        formData.append('show_caption_above_media', 'true');
        formData.append('disable_notification', 'true');
        this.appendRefreshReplyMarkup(formData);
        formData.append('photo', await this.createPngBlob(imagePath), path.basename(imagePath));
        return this.callTelegram('sendPhoto', formData);
    }

    async editMessageMedia(messageId, caption, imagePath) {
        const formData = new FormData();
        formData.append('chat_id', this.telegramConfig.chatId);
        formData.append('message_id', String(messageId));
        formData.append('media', JSON.stringify({
            type: 'photo',
            media: 'attach://photo',
            caption,
            parse_mode: 'HTML',
            show_caption_above_media: true,
        }));
        this.appendRefreshReplyMarkup(formData);
        formData.append('photo', await this.createPngBlob(imagePath), path.basename(imagePath));
        return this.callTelegram('editMessageMedia', formData);
    }

    async editMessageCaption(messageId, caption) {
        const payload = {
            chat_id: this.telegramConfig.chatId,
            message_id: messageId,
            caption,
            parse_mode: 'HTML',
            show_caption_above_media: true,
        };

        if (this.refreshReplyMarkup) {
            payload.reply_markup = this.refreshReplyMarkup;
        }

        return this.callTelegramJson('editMessageCaption', payload);
    }

    async pinMessage(messageId) {
        try {
            await this.callTelegramJson('pinChatMessage', {
                chat_id: this.telegramConfig.chatId,
                message_id: messageId,
                disable_notification: true,
            });
        } catch (error) {
            log('warn', `Failed to pin message ${messageId}.`, error?.description || error?.message);
        }
    }

    isEditableMessageMissing(error) {
        const message = String(error?.description || error?.message || '').toLowerCase();
        return message.includes('message to edit not found') ||
            message.includes('message can\'t be edited') ||
            message.includes('message identifier is not specified');
    }

    async getUpdates(offset) {
        return this.callTelegramJson('getUpdates', {
            offset,
            timeout: this.config.manualRefresh.pollingTimeoutSec,
            allowed_updates: ['callback_query'],
        });
    }

    async answerCallbackQuery(callbackQueryId, text) {
        return this.callTelegramJson('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text,
            show_alert: false,
            cache_time: 0,
        });
    }

    async publishSummary(summary, state) {
        const imagePath = resolveStatusImagePath(this.config.assetsDir, summary.overallStatus);
        const caption = buildCaption({
            overallStatus: summary.overallStatus,
            lastCheckedAt: summary.lastCheckedAt,
            ipResults: summary.results,
        });

        if (!state.messageId) {
            const sentMessage = await this.sendPhotoMessage(caption, imagePath);
            state.messageId = sentMessage.message_id;
            state.lastImageStatus = summary.overallStatus;
            await this.pinMessage(state.messageId);
            return;
        }

        try {
            if (state.lastImageStatus !== summary.overallStatus) {
                await this.editMessageMedia(state.messageId, caption, imagePath);
                state.lastImageStatus = summary.overallStatus;
            } else {
                await this.editMessageCaption(state.messageId, caption);
            }
        } catch (error) {
            if (this.isEditableMessageMissing(error)) {
                const sentMessage = await this.sendPhotoMessage(caption, imagePath);
                state.messageId = sentMessage.message_id;
                state.lastImageStatus = summary.overallStatus;
            } else {
                throw error;
            }
        }

        await this.pinMessage(state.messageId);
    }
}

class MonitorRuntime {
    constructor(config, state, probeClient, publisher, persistState) {
        this.config = config;
        this.state = state;
        this.probeClient = probeClient;
        this.publisher = publisher;
        this.persistState = persistState;
        this.refreshPromise = null;
        this.nextScheduledRunAt = Date.now();
    }

    isRefreshing() {
        return this.refreshPromise !== null;
    }

    isCurrentMessage(messageId) {
        return !this.state.messageId || !messageId || this.state.messageId === messageId;
    }

    scheduleNextRun(baseTimeMs = Date.now()) {
        this.nextScheduledRunAt = baseTimeMs + this.config.checkIntervalMs;
    }

    getManualRefreshCooldownMs(userId, nowMs = Date.now()) {
        pruneExpiredUserCooldowns(this.state, this.config.manualRefresh.userCooldownMs, nowMs);

        const userKey = userId === undefined || userId === null
            ? null
            : String(userId);

        return getManualRefreshCooldownMs({
            nowMs,
            lastCompletedAtMs: this.state.lastRunFinishedAtMs,
            lastUserRefreshAtMs: userKey ? this.state.userCooldowns[userKey] || null : null,
            globalCooldownMs: this.config.manualRefresh.globalCooldownMs,
            userCooldownMs: this.config.manualRefresh.userCooldownMs,
        });
    }

    getManualRefreshDecision(userId) {
        const nowMs = Date.now();

        if (this.isRefreshing()) {
            return {
                accepted: false,
                message: 'проверка уже идет...',
            };
        }

        const remainingCooldownMs = this.getManualRefreshCooldownMs(userId, nowMs);
        if (remainingCooldownMs > 0) {
            return {
                accepted: false,
                message: `подожди ${formatCooldownDuration(remainingCooldownMs)}`,
            };
        }

        return {
            accepted: true,
            message: 'обновляю...',
        };
    }

    async runCheck(trigger, metadata = {}) {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        const refreshPromise = (async () => {
            const startedAtMs = Date.now();
            this.state.lastRunStartedAtMs = startedAtMs;
            this.state.lastRunTrigger = trigger;
            await this.persistState();

            try {
                return await runMonitorIteration(
                    this.probeClient,
                    this.publisher,
                    this.config,
                    this.state,
                    this.persistState,
                    trigger
                );
            } finally {
                const finishedAtMs = Date.now();
                this.state.lastRunFinishedAtMs = finishedAtMs;
                this.scheduleNextRun(finishedAtMs);

                if (trigger === 'manual' && metadata.userId !== undefined && metadata.userId !== null) {
                    this.state.lastManualRefreshAtMs = finishedAtMs;
                    this.state.lastManualRefreshBy = String(metadata.userId);
                }

                pruneExpiredUserCooldowns(this.state, this.config.manualRefresh.userCooldownMs, finishedAtMs);
                await this.persistState();
            }
        })();

        this.refreshPromise = refreshPromise;

        try {
            return await refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    startManualRefresh(userId) {
        const nowMs = Date.now();
        const userKey = userId === undefined || userId === null
            ? null
            : String(userId);

        if (userKey) {
            this.state.userCooldowns[userKey] = nowMs;
        }
        pruneExpiredUserCooldowns(this.state, this.config.manualRefresh.userCooldownMs, nowMs);

        log('info', 'Manual refresh requested.', userKey ? { userId: userKey } : null);

        const refreshPromise = this.runCheck('manual', { userId });
        refreshPromise.catch((error) => {
            log('error', 'Manual refresh failed.', error?.description || error?.message || String(error));
        });
    }
}

async function handleTelegramUpdate(update, runtime, publisher) {
    const callbackQuery = update?.callback_query;
    if (!callbackQuery || callbackQuery.data !== MANUAL_REFRESH_CALLBACK_DATA) {
        return;
    }

    const callbackMessageId = callbackQuery?.message?.message_id || null;
    if (!runtime.isCurrentMessage(callbackMessageId)) {
        await publisher.answerCallbackQuery(callbackQuery.id, 'кнопка устарела');
        return;
    }

    const refreshDecision = runtime.getManualRefreshDecision(callbackQuery.from?.id);
    await publisher.answerCallbackQuery(callbackQuery.id, refreshDecision.message);

    if (refreshDecision.accepted) {
        runtime.startManualRefresh(callbackQuery.from?.id);
    }
}

async function runTelegramCallbackLoop(runtime, publisher, state, persistState) {
    log('info', 'Manual refresh button enabled. Listening for Telegram callback queries.');

    while (true) {
        try {
            const updates = await publisher.getUpdates(state.telegramUpdateOffset || undefined);

            for (const update of updates) {
                try {
                    await handleTelegramUpdate(update, runtime, publisher);
                } catch (error) {
                    log('warn', 'Failed to handle Telegram callback query.', error?.description || error?.message || String(error));
                }

                state.telegramUpdateOffset = update.update_id + 1;
                await persistState();
            }
        } catch (error) {
            log('warn', 'Telegram getUpdates failed.', error?.description || error?.message || String(error));
            await sleep(runtime.config.manualRefresh.pollingErrorRetryMs);
        }
    }
}

async function runScheduledChecksLoop(runtime) {
    while (true) {
        if (!runtime.isRefreshing() && Date.now() >= runtime.nextScheduledRunAt) {
            try {
                await runtime.runCheck('scheduled');
            } catch (error) {
                log('error', 'Scheduled monitor iteration crashed.', error?.description || error?.message || String(error));
            }
            continue;
        }

        await sleep(1000);
    }
}

async function collectIpResults(probeClient, config) {
    try {
        await probeClient.initialize();
        return mapWithConcurrency(
            config.gemini.fixedIps,
            config.probeConcurrency,
            async (ip) => probeClient.probeIp(ip)
        );
    } catch (error) {
        log('error', 'Gemini probing failed. Marking all IPs as unknown.', extractErrorText(error?.response?.data || error?.message));
        return config.gemini.fixedIps.map((ip) => ({
            ip,
            status: IP_STATUS.UNKNOWN,
            detail: 'monitor-failure',
            httpStatus: null,
            errorText: extractErrorText(error?.response?.data || error?.message),
        }));
    }
}

function buildSummary(results, checkedAt = new Date()) {
    const aggregate = computeOverallStatus(results);
    return {
        overallStatus: aggregate.overallStatus,
        counts: aggregate.counts,
        checkedAtIso: checkedAt.toISOString(),
        lastCheckedAt: formatMoscowTimestamp(checkedAt),
        results,
    };
}

async function runMonitorIteration(probeClient, publisher, config, state, persistState, trigger = 'scheduled') {
    const checkedAt = new Date();
    const results = await collectIpResults(probeClient, config);
    const summary = buildSummary(results, checkedAt);

    await publisher.publishSummary(summary, state);
    await appendAuditLog(config.auditLogFilePath, summary.checkedAtIso, summary);

    state.lastCheckedAt = summary.lastCheckedAt;
    state.lastCounts = summary.counts;
    state.lastOverallStatus = summary.overallStatus;
    state.lastCompletedTrigger = trigger;
    await persistState();

    log('info', `Monitor status (${trigger}): ${summary.overallStatus}.`, summary.counts);
    return summary;
}

async function main() {
    const config = await loadMonitorConfig();
    await assertAssetsExist(config);

    const savedState = await loadJsonState(config.stateFilePath);
    const state = {
        messageId: config.telegram.messageId || savedState.messageId || null,
        lastImageStatus: savedState.lastImageStatus || null,
        lastCheckedAt: savedState.lastCheckedAt || null,
        lastCounts: savedState.lastCounts || null,
        lastOverallStatus: savedState.lastOverallStatus || null,
        lastCompletedTrigger: savedState.lastCompletedTrigger || null,
        lastRunTrigger: savedState.lastRunTrigger || null,
        lastRunStartedAtMs: normalizeTimestamp(savedState.lastRunStartedAtMs),
        lastRunFinishedAtMs: normalizeTimestamp(savedState.lastRunFinishedAtMs),
        lastManualRefreshAtMs: normalizeTimestamp(savedState.lastManualRefreshAtMs),
        lastManualRefreshBy: savedState.lastManualRefreshBy || null,
        telegramUpdateOffset: normalizeTimestamp(savedState.telegramUpdateOffset),
        userCooldowns: normalizeUserCooldowns(savedState.userCooldowns),
    };
    pruneExpiredUserCooldowns(state, config.manualRefresh.userCooldownMs);

    const persistState = createStatePersister(config.stateFilePath, state);

    const probeClient = new GeminiIpProbeClient(config);
    const publisher = new TelegramStatusPublisher(config);
    const runtime = new MonitorRuntime(config, state, probeClient, publisher, persistState);

    await persistState();

    const backgroundTasks = [runScheduledChecksLoop(runtime)];
    if (config.manualRefresh.enabled) {
        backgroundTasks.push(runTelegramCallbackLoop(runtime, publisher, state, persistState));
    }

    await Promise.all(backgroundTasks);
}

main().catch((error) => {
    log('error', 'Gemini Telegram monitor failed to start.', error?.message || String(error));
    process.exit(1);
});
