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
    STATUS_IMAGE_FILENAMES,
    buildCaption,
    classifyGeminiProbeResult,
    computeOverallStatus,
    extractErrorText,
    formatMoscowTimestamp,
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

    async sendPhotoMessage(caption, imagePath) {
        const formData = new FormData();
        formData.append('chat_id', this.telegramConfig.chatId);
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        formData.append('show_caption_above_media', 'true');
        formData.append('disable_notification', 'true');
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
        formData.append('photo', await this.createPngBlob(imagePath), path.basename(imagePath));
        return this.callTelegram('editMessageMedia', formData);
    }

    async editMessageCaption(messageId, caption) {
        return this.callTelegramJson('editMessageCaption', {
            chat_id: this.telegramConfig.chatId,
            message_id: messageId,
            caption,
            parse_mode: 'HTML',
            show_caption_above_media: true,
        });
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

async function runMonitorIteration(probeClient, publisher, config, state) {
    const checkedAt = new Date();
    const results = await collectIpResults(probeClient, config);
    const summary = buildSummary(results, checkedAt);

    await publisher.publishSummary(summary, state);
    await appendAuditLog(config.auditLogFilePath, summary.checkedAtIso, summary);

    state.lastCheckedAt = summary.lastCheckedAt;
    state.lastCounts = summary.counts;
    await saveJsonState(config.stateFilePath, state);

    log('info', `Monitor status: ${summary.overallStatus}.`, summary.counts);
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
    };

    const probeClient = new GeminiIpProbeClient(config);
    const publisher = new TelegramStatusPublisher(config);

    while (true) {
        const iterationStartedAt = Date.now();

        try {
            await runMonitorIteration(probeClient, publisher, config, state);
        } catch (error) {
            log('error', 'Monitor iteration crashed.', error?.description || error?.message || String(error));
        }

        const elapsedMs = Date.now() - iterationStartedAt;
        const delayMs = Math.max(0, config.checkIntervalMs - elapsedMs);
        await sleep(delayMs);
    }
}

main().catch((error) => {
    log('error', 'Gemini Telegram monitor failed to start.', error?.message || String(error));
    process.exit(1);
});
