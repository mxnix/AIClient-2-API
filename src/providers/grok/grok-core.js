import axios from 'axios';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { API_ACTIONS, isRetryableNetworkError } from '../../utils/common.js';
import { getProviderModels } from '../provider-models.js';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import { GrokConverter } from '../../converters/strategies/GrokConverter.js';
import { ConverterFactory } from '../../converters/ConverterFactory.js';
import * as readline from 'readline';
import { getProviderPoolManager } from '../../services/service-manager.js';

// 配置 HTTP/HTTPS agent 限制连接池大小
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

const DEFAULT_GROK_ENDPOINT = 'https://grok.com/rest/app-chat/conversations/new';
const GROK_MODELS = getProviderModels(MODEL_PROVIDER.GROK_CUSTOM);

const MODEL_MAPPING = {
    'grok-3': { name: 'grok-3', mode: 'MODEL_MODE_GROK_3' },
    'grok-3-mini': { name: 'grok-3', mode: 'MODEL_MODE_GROK_3_MINI_THINKING' },
    'grok-3-thinking': { name: 'grok-3', mode: 'MODEL_MODE_GROK_3_THINKING' },
    'grok-4': { name: 'grok-4', mode: 'MODEL_MODE_GROK_4' },
    'grok-4-mini': { name: 'grok-4-mini', mode: 'MODEL_MODE_GROK_4_MINI_THINKING' },
    'grok-4-thinking': { name: 'grok-4', mode: 'MODEL_MODE_GROK_4_THINKING' },
    'grok-4-heavy': { name: 'grok-4', mode: 'MODEL_MODE_HEAVY' },
    'grok-4.1-mini': { name: 'grok-4-1-thinking-1129', mode: 'MODEL_MODE_GROK_4_1_MINI_THINKING' },
    'grok-4.1-fast': { name: 'grok-4-1-thinking-1129', mode: 'MODEL_MODE_FAST' },
    'grok-4.1-expert': { name: 'grok-4-1-thinking-1129', mode: 'MODEL_MODE_EXPERT' },
    'grok-4.1-thinking': { name: 'grok-4-1-thinking-1129', mode: 'MODEL_MODE_GROK_4_1_THINKING' },
    'grok-4.20-beta': { name: 'grok-420', mode: 'MODEL_MODE_GROK_420' },
    'grok-imagine-1.0': { name: 'grok-3', mode: 'MODEL_MODE_FAST' },
    'grok-imagine-1.0-edit': { name: 'imagine-image-edit', mode: 'MODEL_MODE_FAST' },
    'grok-imagine-1.0-video': { name: 'grok-3', mode: 'MODEL_MODE_FAST' }
};

export class GrokApiService {
    constructor(config) {
        this.config = config;
        this.uuid = config.uuid; // 存储 UUID 以便后续调用账号池方法
        this.token = config.GROK_COOKIE_TOKEN;
        this.cfClearance = config.GROK_CF_CLEARANCE;
        this.userAgent = config.GROK_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
        this.baseUrl = config.GROK_BASE_URL || 'https://grok.com';
        this.chatApi = `${this.baseUrl}/rest/app-chat/conversations/new`;
        this.isInitialized = false;
        this.converter = new GrokConverter();
        this.lastSyncAt = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Grok] Initializing Grok API Service...');
        if (!this.token) {
            logger.warn('[Grok] GROK_COOKIE_TOKEN is missing. Requests will fail if authorization is required.');
        }
        if (!this.cfClearance) {
            logger.warn('[Grok] GROK_CF_CLEARANCE is missing. This might cause Cloudflare challenges.');
        }
        
        // Initial usage sync
        try {
            await this.getUsageLimits();
        } catch (error) {
            logger.warn('[Grok] Initial usage sync failed:', error.message);
        }

        this.isInitialized = true;
    }

    async refreshToken() {
        // Grok SSO tokens are manual for now, but we use this to sync usage/quota from API
        logger.info('[Grok] Syncing usage limits...');
        try {
            await this.getUsageLimits();
            return Promise.resolve();
        } catch (error) {
            logger.error('[Grok] Failed to sync usage limits:', error.message);
            return Promise.reject(error);
        }
    }

    /**
     * Fetch rate limits from Grok (RateLimitsReverse)
     */
    async getUsageLimits() {
        const headers = this.buildHeaders();
        const rateLimitsApi = `${this.baseUrl}/rest/rate-limits`;

        const payload = {
            "requestKind": "DEFAULT",
            "modelName": "grok-4-1-thinking-1129", // Default model for checking limits
        };

        const axiosConfig = {
            method: 'post',
            url: rateLimitsApi,
            headers: headers,
            data: payload,
            httpAgent,
            httpsAgent,
            timeout: 30000
        };

        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.GROK_CUSTOM);

        try {
            const response = await axios(axiosConfig);
            const data = response.data;
            console.log("111111111111111111111111111", JSON.stringify(data))
            
            let remaining = data.remainingTokens;
            if (remaining === undefined) {
                remaining = data.remainingQueries !== undefined ? data.remainingQueries : data.totalQueries;
            }
            
            // 注入固定总量逻辑 (根据反馈：查询总数固定为 80)
            if (data.remainingQueries !== undefined || data.totalQueries !== undefined) {
                data.totalLimit = 80;
                // 计算已用次数
                data.usedQueries = Math.max(0, 80 - (data.remainingQueries !== undefined ? data.remainingQueries : data.totalQueries));
            }
            
            this.lastSyncAt = Date.now();
            logger.info(`[Grok Usage] Synced: remaining=${remaining}, token=${this.token.substring(0, 10)}...`);
            
            // 将同步到的数据保存到 config 中，以便持久化和 UI 显示
            this.config.usageData = data;
            this.config.lastHealthCheckTime = new Date().toISOString();
            
            return {
                lastUpdated: this.lastSyncAt,
                remaining: remaining,
                ...data
            };
        } catch (error) {
            const status = error.response?.status;
            if (status === 401 || status === 403) {
                logger.error('[Grok Usage] Authentication failed during usage sync.');
            }
            throw error;
        }
    }

    isExpiryDateNear() {
        // Grok tokens don't have a fixed expiry date, but we use this to trigger periodic usage sync
        // If not synced for more than X minutes, consider it "near expiry" to trigger a refresh/sync
        if (!this.lastSyncAt) return true;
        
        const now = Date.now();
        const nearMinutes = this.config.CRON_NEAR_MINUTES || 15;
        const interval = nearMinutes * 60 * 1000;
        const isNear = (now - this.lastSyncAt) > interval;
        
        if (isNear) {
            logger.debug(`[Grok] Usage sync is stale (> ${nearMinutes}m), triggering refresh.`);
        }
        
        return isNear;
    }

    /**
     * Generate Statsig ID (StatsigGenerator)
     */
    genStatsigId() {
        // Static Statsig ID from  code
        return "ZTpUeXBlRXJyb3I6IENhbm5vdCByZWFkIHByb3BlcnRpZXMgb2YgdW5kZWZpbmVkIChyZWFkaW5nICdjaGlsZE5vZGVzJyk=";
    }

    buildHeaders() {
        let ssoToken = this.token || "";
        if (ssoToken.startsWith("sso=")) {
            ssoToken = ssoToken.substring(4);
        }

        const cookie = ssoToken ? [`sso=${ssoToken}`, `sso-rw=${ssoToken}`] : [];
        if (this.cfClearance) {
            cookie.push(`cf_clearance=${this.cfClearance}`);
        }

        const headers = {
            'accept': '*/*',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'baggage': 'sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c',
            'content-type': 'application/json',
            'cookie': cookie.join('; '),
            'origin': this.baseUrl,
            'priority': 'u=1, i',
            'referer': `${this.baseUrl}/`,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': this.userAgent,
            'x-statsig-id': this.genStatsigId(),
            'x-xai-request-id': uuidv4()
        };

        // Sync Sec-Ch-Ua logic
        if (this.userAgent && (this.userAgent.includes("Chrome/") || this.userAgent.includes("Chromium/") || this.userAgent.includes("Edg/"))) {
            let brand = "Google Chrome";
            if (this.userAgent.includes("Edg/")) brand = "Microsoft Edge";
            
            const versionMatch = this.userAgent.match(/(?:Chrome|Chromium|Edg)\/(\d+)/);
            const version = versionMatch ? versionMatch[1] : "133";
            
            headers['sec-ch-ua'] = `"${brand}";v="${version}", "Chromium";v="${version}", "Not(A:Brand";v="24"`;
            headers['sec-ch-ua-mobile'] = this.userAgent.toLowerCase().includes("mobile") ? '?1' : '?0';
            
            // Platform detection
            let platform = "Windows";
            if (this.userAgent.includes("Mac OS X")) platform = "macOS";
            else if (this.userAgent.includes("Android")) platform = "Android";
            else if (this.userAgent.includes("iPhone") || this.userAgent.includes("iPad")) platform = "iOS";
            else if (this.userAgent.includes("Linux")) platform = "Linux";
            
            headers['sec-ch-ua-platform'] = `"${platform}"`;
        }

        return headers;
    }

    buildPayload(modelId, requestBody) {
        const mapping = MODEL_MAPPING[modelId] || MODEL_MAPPING['grok-3'];
        
        let message = requestBody.message || "";
        let toolOverrides = requestBody.toolOverrides || {};
        let fileAttachments = requestBody.fileAttachments || [];
        let modelConfigOverride = requestBody.responseMetadata?.modelConfigOverride || {};

        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            // 1. 格式化工具历史 (仅当提供了 tools 时，逻辑)
            let processedMessages = requestBody.messages;
            if (requestBody.tools && requestBody.tools.length > 0) {
                processedMessages = this.converter.formatToolHistory(requestBody.messages);
            }
            
            // 2. 构建工具提示词并注入 (逻辑)
            const toolPrompt = this.converter.buildToolPrompt(requestBody.tools, requestBody.tool_choice);
            
            // 3. 构建 Tool Overrides (仿真 passthrough 模式)
            if (requestBody.tools && Object.keys(toolOverrides).length === 0) {
                toolOverrides = this.converter.buildToolOverrides(requestBody.tools);
            }

            // 4. 提取文本和附件 (MessageExtractor.extract 逻辑)
            const extracted = [];
            const imageAttachments = [];
            const localFileAttachments = [];

            for (const msg of processedMessages) {
                const role = msg.role || "user";
                const content = msg.content;
                const parts = [];

                if (typeof content === 'string') {
                    if (content.trim()) parts.push(content.trim());
                } else if (Array.isArray(content)) {
                    for (const item of content) {
                        if (item.type === 'text' && item.text?.trim()) {
                            parts.push(item.text.trim());
                        } else if (item.type === 'image_url' && item.image_url?.url) {
                            imageAttachments.push(item.image_url.url);
                        } else if (item.type === 'input_audio' && item.input_audio?.data) {
                            localFileAttachments.push(item.input_audio.data);
                        } else if (item.type === 'file' && item.file?.file_data) {
                            localFileAttachments.push(item.file.file_data);
                        }
                    }
                }

                // 保留工具调用轨迹 (逻辑: [tool_call] 格式)
                const toolCalls = msg.tool_calls;
                if (role === "assistant" && parts.length === 0 && Array.isArray(toolCalls)) {
                    for (const call of toolCalls) {
                        const fn = call.function || {};
                        const name = fn.name || call.name || "tool";
                        let args = fn.arguments || "";
                        if (typeof args !== 'string') args = JSON.stringify(args);
                        parts.push(`[tool_call] ${name} ${args.trim()}`.trim());
                    }
                }

                if (parts.length > 0) {
                    let roleLabel = role;
                    if (role === "tool") {
                        const name = msg.name || "unknown";
                        const callId = msg.tool_call_id || "";
                        roleLabel = `tool[${name.trim()}]`;
                        if (callId.trim()) roleLabel += `#${callId.trim()}`;
                    }
                    extracted.push({ role: roleLabel, text: parts.join("\n") });
                }
            }

            // 5. 处理提取后的文本拼接 (逻辑)
            let lastUserIndex = -1;
            for (let i = extracted.length - 1; i >= 0; i--) {
                if (extracted[i].role === 'user') {
                    lastUserIndex = i;
                    break;
                }
            }

            const texts = [];
            for (let i = 0; i < extracted.length; i++) {
                const item = extracted[i];
                if (i === lastUserIndex) {
                    texts.push(item.text);
                } else {
                    texts.push(`${item.role}: ${item.text}`);
                }
            }

            message = texts.join("\n\n");
            if (toolPrompt) {
                message = `${toolPrompt}\n\n${message}`;
            }

            // Fallback for attachments (逻辑)
            if (!message.trim() && (requestBody.fileAttachments?.length || imageAttachments.length || localFileAttachments.length)) {
                message = "Refer to the following content:";
            }

            // 6. 附件准备 (供后续上传)
            requestBody._extractedImages = imageAttachments;
            requestBody._extractedFiles = localFileAttachments;
        }

        // 视频生成支持 (特定参数从 requestBody 透传)
        if (requestBody.videoGenModelConfig) {
            modelConfigOverride.modelMap = {
                videoGenModelConfig: requestBody.videoGenModelConfig
            };
            toolOverrides.videoGen = true;
            if (requestBody.videoGenPrompt) {
                message = requestBody.videoGenPrompt;
            }
        }

        const payload = {
            "deviceEnvInfo": {
                "darkModeEnabled": false,
                "devicePixelRatio": 2,
                "screenWidth": 2056,
                "screenHeight": 1329,
                "viewportWidth": 2056,
                "viewportHeight": 1083,
            },
            "disableMemory": false,
            "disableSearch": false,
            "disableSelfHarmShortCircuit": false,
            "disableTextFollowUps": false,
            "enableImageGeneration": true,
            "enableImageStreaming": true,
            "enableSideBySide": true,
            "fileAttachments": fileAttachments,
            "forceConcise": false,
            "forceSideBySide": false,
            "imageAttachments": [],
            "imageGenerationCount": 2,
            "isAsyncChat": false,
            "isReasoning": false,
            "message": message,
            "modelMode": mapping.mode,
            "modelName": mapping.name,
            "responseMetadata": {
                "requestModelDetails": { "modelId": mapping.name },
                "modelConfigOverride": modelConfigOverride
            },
            "returnImageBytes": false,
            "returnRawGrokInXaiRequest": false,
            "sendFinalMetadata": true,
            "temporary": true,
            "toolOverrides": toolOverrides,
        };

        return payload;
    }

    async generateContent(model, requestBody) {
        const stream = this.generateContentStream(model, requestBody);
        const collected = {
            message: "",
            responseId: "",
            llmInfo: {},
            rolloutId: "",
            modelResponse: null,
            cardAttachment: null,
            streamingImageGenerationResponse: null,
            streamingVideoGenerationResponse: null,
            finalVideoUrl: null,
            finalThumbnailUrl: null
        };

        for await (const chunk of stream) {
            const resp = chunk.result?.response;
            if (!resp) continue;

            if (resp.token) collected.message += resp.token;
            if (resp.responseId) collected.responseId = resp.responseId;
            if (resp.llmInfo) Object.assign(collected.llmInfo, resp.llmInfo);
            if (resp.rolloutId) collected.rolloutId = resp.rolloutId;
            
            if (resp.modelResponse) collected.modelResponse = resp.modelResponse;
            if (resp.cardAttachment) collected.cardAttachment = resp.cardAttachment;
            
            if (resp.streamingImageGenerationResponse) {
                collected.streamingImageGenerationResponse = resp.streamingImageGenerationResponse;
            }
            
            if (resp.streamingVideoGenerationResponse) {
                collected.streamingVideoGenerationResponse = resp.streamingVideoGenerationResponse;
                if (resp.streamingVideoGenerationResponse.progress === 100 && resp.streamingVideoGenerationResponse.videoUrl) {
                    collected.finalVideoUrl = resp.streamingVideoGenerationResponse.videoUrl;
                    collected.finalThumbnailUrl = resp.streamingVideoGenerationResponse.thumbnailImageUrl;
                }
            }
        }

        return collected;
    }

    /**
     * Upload file to Grok (UploadService)
     */
    async uploadFile(fileInput) {
        let fileName = "file.bin";
        let b64 = "";
        let mime = "application/octet-stream";

        if (fileInput.startsWith("data:")) {
            const match = fileInput.match(/^data:([^;]+);base64,(.*)$/);
            if (match) {
                mime = match[1];
                b64 = match[2];
                const ext = mime.split("/")[1] || "bin";
                fileName = `file.${ext}`;
            }
        } else if (fileInput.startsWith("http")) {
            // 这里简单处理，后续可以实现下载再上传
            return null; 
        }

        if (!b64) return null;

        const headers = this.buildHeaders();
        const uploadApi = `${this.baseUrl}/rest/app-chat/upload-file`;

        const axiosConfig = {
            method: 'post',
            url: uploadApi,
            headers: headers,
            data: {
                fileName,
                fileMimeType: mime,
                content: b64
            },
            httpAgent,
            httpsAgent,
            timeout: 30000
        };

        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.GROK_CUSTOM);

        try {
            const response = await axios(axiosConfig);
            return response.data; // { fileMetadataId: "...", fileUri: "..." }
        } catch (error) {
            logger.error(`[Grok Upload] Failed to upload file:`, error.message);
            return null;
        }
    }

    async * generateContentStream(model, requestBody) {
        // 检查是否即将到期（需要同步用量），如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[Grok] Usage sync is stale, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GROK_CUSTOM, {
                    uuid: this.uuid
                });
            }
        }

        // 1. 先构建一次 payload 以便触发消息提取和附件解析 (逻辑顺序)
        // 这一步会填充 requestBody._extractedImages 和 requestBody._extractedFiles
        this.buildPayload(model, requestBody);

        let fileAttachments = requestBody.fileAttachments || [];
        const imagesToUpload = requestBody._extractedImages || [];
        const filesToUpload = requestBody._extractedFiles || [];

        // 2. 处理附件上传
        if (imagesToUpload.length > 0 || filesToUpload.length > 0) {
            const allToUpload = [...imagesToUpload, ...filesToUpload];
            logger.info(`[Grok] Found ${allToUpload.length} attachments to upload.`);
            
            for (const data of allToUpload) {
                const result = await this.uploadFile(data);
                if (result?.fileMetadataId) {
                    fileAttachments.push(result.fileMetadataId);
                }
            }
            // 更新附件列表
            requestBody.fileAttachments = fileAttachments;
        }

        // 3. 重新构建最终 payload (附件已上传并关联)
        const payload = this.buildPayload(model, requestBody);
        const headers = this.buildHeaders();

        const axiosConfig = {
            method: 'post',
            url: this.chatApi,
            headers: headers,
            data: payload,
            responseType: 'stream',
            httpAgent,
            httpsAgent,
            timeout: 60000,
            maxRedirects: 0
        };

        configureAxiosProxy(axiosConfig, this.config, MODEL_PROVIDER.GROK_CUSTOM);

        try {
            const response = await axios(axiosConfig);
            const contentType = response.headers['content-type'] || '';
            logger.debug(`[Grok Stream] Connected. Status: ${response.status}, Content-Type: ${contentType}`);

            if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson') && !contentType.includes('application/json')) {
                logger.warn(`[Grok Stream] Unexpected Content-Type: ${contentType}. Possible redirect to login page?`);
                if (contentType.includes('text/html')) {
                    throw new Error('Grok returned HTML instead of SSE. Your SSO token might be invalid or expired.');
                }
            }

            const rl = readline.createInterface({
                input: response.data,
                terminal: false
            });

            let lineCount = 0;
            let lastResponseId = payload.responseMetadata?.requestModelDetails?.modelId || "final";

            for await (const line of rl) {
                lineCount++;
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                // Log raw line for debugging (only first few characters or if short)
                if (lineCount <= 5) {
                    logger.debug(`[Grok Stream] Raw line ${lineCount}: ${trimmedLine.slice(0, 100)}`);
                }

                let dataStr = trimmedLine;
                if (trimmedLine.startsWith('data: ')) {
                    dataStr = trimmedLine.slice(6).trim();
                }

                if (dataStr === '[DONE]') break;
                
                try {
                    const json = JSON.parse(dataStr);
                    if (json.result?.response?.responseId) {
                        lastResponseId = json.result.response.responseId;
                    }
                    yield json;
                } catch (e) {
                    // Grok sometimes sends empty data or comments
                    if (dataStr !== ':' && !dataStr.startsWith(':')) {
                        logger.debug('[Grok Stream] Non-JSON line ignored:', dataStr);
                    }
                }
            }

            logger.debug(`[Grok Stream] Finished loop. Total lines: ${lineCount}`);

            // Yield a final chunk to signal the converter to finish and cleanup
            yield { 
                result: { 
                    response: { 
                        isDone: true, 
                        responseId: lastResponseId
                    } 
                } 
            };
        } catch (error) {
            this.handleApiError(error);
        }
    }

    handleApiError(error) {
        const status = error.response?.status;
        const errorMessage = error.message || '';
        logger.error(`[Grok API] Error (Status: ${status}):` ,errorMessage);
        
        if (status === 401 || status === 403) {
            error.shouldSwitchCredential = true;
            error.message = 'Grok authentication failed (SSO token invalid or expired)';
        }
        
        throw error;
    }

    async listModels() {
        const formattedModels = GROK_MODELS.map(modelId => {
            const displayName = modelId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            return {
                id: modelId,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "xai",
                display_name: displayName,
            };
        });
        return { data: formattedModels };
    }
}
