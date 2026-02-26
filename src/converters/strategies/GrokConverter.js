/**
 * Grok转换器
 * 处理Grok协议与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { BaseConverter } from '../BaseConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';

/**
 * Grok转换器类
 * 实现Grok协议到其他协议的转换
 */
export class GrokConverter extends BaseConverter {
    constructor() {
        super('grok');
        // 用于跟踪每个请求的状态
        this.requestStates = new Map();
    }

    /**
     * 获取或初始化请求状态
     */
    _getState(requestId) {
        if (!this.requestStates.has(requestId)) {
            this.requestStates.set(requestId, {
                think_opened: false,
                image_think_active: false,
                video_think_active: false,
                role_sent: false,
                tool_buffer: "",
                last_is_thinking: false,
                fingerprint: "",
                content_buffer: "", // 用于缓存内容以解析工具调用
                has_tool_call: false,
                rollout_id: "",
                in_tool_call: false // 是否处于 <tool_call> 块内
            });
        }
        return this.requestStates.get(requestId);
    }

    /**
     * 构建工具系统提示词 (build_tool_prompt)
     */
    buildToolPrompt(tools, toolChoice = "auto", parallelToolCalls = true) {
        if (!tools || tools.length === 0 || toolChoice === "none") {
            return "";
        }

        const lines = [
            "# Available Tools",
            "",
            "You have access to the following tools. To call a tool, output a <tool_call> block with a JSON object containing \"name\" and \"arguments\".",
            "",
            "Format:",
            "<tool_call>",
            '{"name": "function_name", "arguments": {"param": "value"}}',
            "</tool_call>",
            "",
        ];

        if (parallelToolCalls) {
            lines.push("You may make multiple tool calls in a single response by using multiple <tool_call> blocks.");
            lines.push("");
        }

        lines.push("## Tool Definitions");
        lines.push("");
        for (const tool of tools) {
            if (tool.type !== "function") continue;
            const func = tool.function || {};
            lines.push(`### ${func.name}`);
            if (func.description) lines.push(func.description);
            if (func.parameters) lines.push(`Parameters: ${JSON.stringify(func.parameters)}`);
            lines.push("");
        }

        if (toolChoice === "required") {
            lines.push("IMPORTANT: You MUST call at least one tool in your response. Do not respond with only text.");
        } else if (typeof toolChoice === 'object' && toolChoice.function?.name) {
            lines.push(`IMPORTANT: You MUST call the tool "${toolChoice.function.name}" in your response.`);
        } else {
            lines.push("Decide whether to call a tool based on the user's request. If you don't need a tool, respond normally with text only.");
        }

        lines.push("");
        lines.push("When you call a tool, you may include text before or after the <tool_call> blocks, but the tool call blocks must be valid JSON.");

        return lines.join("\n");
    }

    /**
     * 格式化工具历史 (format_tool_history)
     */
    formatToolHistory(messages) {
        const result = [];
        for (const msg of messages) {
            const role = msg.role;
            const content = msg.content;
            const toolCalls = msg.tool_calls;

            if (role === "assistant" && toolCalls && toolCalls.length > 0) {
                const parts = [];
                if (content) parts.push(typeof content === 'string' ? content : JSON.stringify(content));
                for (const tc of toolCalls) {
                    const func = tc.function || {};
                    parts.push(`<tool_call>{"name":"${func.name}","arguments":${func.arguments || "{}"}}</tool_call>`);
                }
                result.push({ role: "assistant", content: parts.join("\n") });
            } else if (role === "tool") {
                const toolName = msg.name || "unknown";
                const callId = msg.tool_call_id || "";
                const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
                result.push({
                    role: "user",
                    content: `tool (${toolName}, ${callId}): ${contentStr}`
                });
            } else {
                result.push(msg);
            }
        }
        return result;
    }

    /**
     * 解析工具调用 (parse_tool_calls)
     */
    parseToolCalls(content) {
        if (!content) return { text: content, toolCalls: null };

        const toolCallRegex = /<tool_call>\s*(.*?)\s*<\/tool_call>/gs;
        const matches = [...content.matchAll(toolCallRegex)];
        
        if (matches.length === 0) return { text: content, toolCalls: null };

        const toolCalls = [];
        for (const match of matches) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed.name) {
                    let args = parsed.arguments || {};
                    const argumentsStr = typeof args === 'string' ? args : JSON.stringify(args);
                    
                    toolCalls.push({
                        id: `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
                        type: "function",
                        function: {
                            name: parsed.name,
                            arguments: argumentsStr
                        }
                    });
                }
            } catch (e) {
                // 忽略解析失败的块
            }
        }

        if (toolCalls.length === 0) return { text: content, toolCalls: null };

        // 提取文本内容
        let text = content;
        for (const match of matches) {
            text = text.replace(match[0], "");
        }
        text = text.trim() || null;

        return { text, toolCalls };
    }

    /**
     * 转换请求
     */
    convertRequest(data, targetProtocol) {
        return data;
    }

    /**
     * 转换响应
     */
    convertResponse(data, targetProtocol, model) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            default:
                return data;
        }
    }

    /**
     * 转换流式响应块
     */
    convertStreamChunk(chunk, targetProtocol, model) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model);
            default:
                return chunk;
        }
    }

    /**
     * 转换模型列表
     */
    convertModelList(data, targetProtocol) {
        return data;
    }

    /**
     * 构建工具覆盖配置 (build_tool_overrides)
     */
    buildToolOverrides(tools) {
        if (!tools || !Array.isArray(tools)) {
            return {};
        }

        const toolOverrides = {};
        for (const tool of tools) {
            if (tool.type !== "function") continue;
            const func = tool.function || {};
            const name = func.name;
            if (!name) continue;
            
            toolOverrides[name] = {
                "enabled": true,
                "description": func.description || "",
                "parameters": func.parameters || {}
            };
        }

        return toolOverrides;
    }

    /**
     * 递归收集响应中的图片 URL
     */
    _collectImages(obj) {
        const urls = [];
        const seen = new Set();

        const add = (url) => {
            if (!url || seen.has(url)) return;
            seen.add(url);
            urls.push(url);
        };

        const walk = (value) => {
            if (value && typeof value === 'object') {
                if (Array.isArray(value)) {
                    value.forEach(walk);
                } else {
                    for (const [key, item] of Object.entries(value)) {
                        if (key === "generatedImageUrls" || key === "imageUrls" || key === "imageURLs") {
                            if (Array.isArray(item)) {
                                item.forEach(url => typeof url === 'string' && add(url));
                            } else if (typeof item === 'string') {
                                add(item);
                            }
                            continue;
                        }
                        walk(item);
                    }
                }
            }
        };

        walk(obj);
        return urls;
    }

    /**
     * 渲染图片为 Markdown
     */
    _renderImage(url, imageId = "image") {
        let finalUrl = url;
        if (!url.startsWith('http')) {
            finalUrl = `https://assets.grok.com${url.startsWith('/') ? '' : '/'}${url}`;
        }
        return `![${imageId}](${finalUrl})`;
    }

    /**
     * 渲染视频为 Markdown/HTML (render_video)
     */
    _renderVideo(videoUrl, thumbnailImageUrl = "") {
        let finalVideoUrl = videoUrl;
        if (!videoUrl.startsWith('http')) {
            finalVideoUrl = `https://assets.grok.com${videoUrl.startsWith('/') ? '' : '/'}${videoUrl}`;
        }
        
        let finalThumbUrl = thumbnailImageUrl;
        if (thumbnailImageUrl && !thumbnailImageUrl.startsWith('http')) {
            finalThumbUrl = `https://assets.grok.com${thumbnailImageUrl.startsWith('/') ? '' : '/'}${thumbnailImageUrl}`;
        }

        return `\n[![video](${finalThumbUrl || 'https://assets.grok.com/favicon.ico'})](${finalVideoUrl})\n[Play Video](${finalVideoUrl})\n`;
    }

    /**
     * 提取工具卡片文本 (extract_tool_text)
     */
    _extractToolText(raw, rolloutId = "") {
        if (!raw) return "";
        
        const nameMatch = raw.match(/<xai:tool_name>(.*?)<\/xai:tool_name>/s);
        const argsMatch = raw.match(/<xai:tool_args>(.*?)<\/xai:tool_args>/s);

        let name = nameMatch ? nameMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim() : "";
        let args = argsMatch ? argsMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim() : "";

        let payload = null;
        if (args) {
            try {
                payload = JSON.parse(args);
            } catch (e) {
                payload = null;
            }
        }

        let label = name;
        let text = args;
        const prefix = rolloutId ? `[${rolloutId}]` : "";

        if (name === "web_search") {
            label = `${prefix}[WebSearch]`;
            if (payload && typeof payload === 'object') {
                text = payload.query || payload.q || "";
            }
        } else if (name === "search_images") {
            label = `${prefix}[SearchImage]`;
            if (payload && typeof payload === 'object') {
                text = payload.image_description || payload.description || payload.query || "";
            }
        } else if (name === "chatroom_send") {
            label = `${prefix}[AgentThink]`;
            if (payload && typeof payload === 'object') {
                text = payload.message || "";
            }
        }

        if (label && text) return `${label} ${text}`.trim();
        if (label) return label;
        if (text) return text;
        return raw.replace(/<[^>]+>/g, "").trim();
    }

    /**
     * 过滤特殊标签
     */
    _filterToken(token, requestId = "") {
        if (!token) return token;
        
        let filtered = token;

        // 移除 xai:tool_usage_card 及其内容，不显示工具调用的过程输出
        filtered = filtered.replace(/<xai:tool_usage_card[^>]*>.*?<\/xai:tool_usage_card>/gs, "");
        filtered = filtered.replace(/<xai:tool_usage_card[^>]*\/>/gs, "");
        
        // 移除其他内部标签
        const tagsToFilter = ["rolloutId", "responseId", "isThinking"];
        for (const tag of tagsToFilter) {
            const pattern = new RegExp(`<${tag}[^>]*>.*?<\\/${tag}>|<${tag}[^>]*\\/>`, 'gs');
            filtered = filtered.replace(pattern, "");
        }

        return filtered;
    }

    /**
     * Grok响应 -> OpenAI响应
     */
    toOpenAIResponse(grokResponse, model) {
        if (!grokResponse) return null;

        const responseId = grokResponse.responseId || `chatcmpl-${uuidv4()}`;
        let content = grokResponse.message || "";
        const modelHash = grokResponse.llmInfo?.modelHash || "";

        // 过滤内容
        content = this._filterToken(content, responseId);

        // 收集图片并追加
        const imageUrls = this._collectImages(grokResponse);
        if (imageUrls.length > 0) {
            content += "\n";
            for (const url of imageUrls) {
                content += this._renderImage(url) + "\n";
            }
        }

        // 处理视频 (非流式模式)
        if (grokResponse.finalVideoUrl) {
            content += this._renderVideo(grokResponse.finalVideoUrl, grokResponse.finalThumbnailUrl);
        }

        // 解析工具调用
        const { text, toolCalls } = this.parseToolCalls(content);

        const result = {
            id: responseId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            system_fingerprint: modelHash,
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: text,
                },
                finish_reason: toolCalls ? "tool_calls" : "stop",
            }],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
        };

        if (toolCalls) {
            result.choices[0].message.tool_calls = toolCalls;
        }

        return result;
    }

    _formatResponseId(id) {
        if (!id) return `chatcmpl-${uuidv4()}`;
        if (id.startsWith('chatcmpl-')) return id;
        return `chatcmpl-${id}`;
    }

    /**
     * Grok流式响应块 -> OpenAI流式响应块
     */
    toOpenAIStreamChunk(grokChunk, model) {
        if (!grokChunk || !grokChunk.result || !grokChunk.result.response) {
            return null;
        }

        const resp = grokChunk.result.response;
        const rawResponseId = resp.responseId || "";
        const responseId = this._formatResponseId(rawResponseId);
        const state = this._getState(responseId);
        
        if (resp.llmInfo?.modelHash && !state.fingerprint) {
            state.fingerprint = resp.llmInfo.modelHash;
        }
        if (resp.rolloutId) {
            state.rollout_id = String(resp.rolloutId);
        }

        const chunks = [];

        // 0. 发送角色信息（仅第一次）
        if (!state.role_sent) {
            chunks.push({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                system_fingerprint: state.fingerprint,
                choices: [{
                    index: 0,
                    delta: { role: "assistant", content: "" },
                    finish_reason: null
                }]
            });
            state.role_sent = true;
        }

        // 处理结束标志
        if (resp.isDone) {
            let finalContent = "";
            /*
            if (state.think_opened) {
                finalContent += "\n</think>\n";
                state.think_opened = false;
            }
            */

            // 处理 buffer 中的工具调用
            const { text, toolCalls } = this.parseToolCalls(state.content_buffer);
            
            if (toolCalls) {
                chunks.push({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    system_fingerprint: state.fingerprint,
                    choices: [{
                        index: 0,
                        delta: { 
                            content: ((/* finalContent + */ "") + (text || "")).trim() || null,
                            tool_calls: toolCalls 
                        },
                        finish_reason: "tool_calls"
                    }]
                });
            } else {
                chunks.push({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    system_fingerprint: state.fingerprint,
                    choices: [{
                        index: 0,
                        delta: { content: /* finalContent || */ null },
                        finish_reason: "stop"
                    }]
                });
            }

            // 清理状态
            this.requestStates.delete(responseId);
            return chunks;
        }

        let deltaContent = "";
        let deltaReasoning = "";

        // 1. 处理图片生成进度
        if (resp.streamingImageGenerationResponse) {
            const img = resp.streamingImageGenerationResponse;
            state.image_think_active = true;
            /* 
            if (!state.think_opened) {
                deltaReasoning += "<think>\n";
                state.think_opened = true;
            }
            */
            const idx = (img.imageIndex || 0) + 1;
            const progress = img.progress || 0;
            deltaReasoning += `正在生成第${idx}张图片中，当前进度${progress}%\n`;
        }

        // 2. 处理视频生成进度 (VideoStreamProcessor)
        if (resp.streamingVideoGenerationResponse) {
            const vid = resp.streamingVideoGenerationResponse;
            state.video_think_active = true;
            /*
            if (!state.think_opened) {
                deltaReasoning += "<think>\n";
                state.think_opened = true;
            }
            */
            const progress = vid.progress || 0;
            deltaReasoning += `正在生成视频中，当前进度${progress}%\n`;

            if (progress === 100 && vid.videoUrl) {
                /*
                if (state.think_opened) {
                    deltaContent += "\n</think>\n";
                    state.think_opened = false;
                }
                */
                state.video_think_active = false;
                deltaContent += this._renderVideo(vid.videoUrl, vid.thumbnailImageUrl);
            }
        }

        // 3. 处理模型响应（通常包含完整消息或图片）
        if (resp.modelResponse) {
            const mr = resp.modelResponse;
            /*
            if ((state.image_think_active || state.video_think_active) && state.think_opened) {
                deltaContent += "\n</think>\n";
                state.think_opened = false;
            }
            */
            state.image_think_active = false;
            state.video_think_active = false;

            const imageUrls = this._collectImages(mr);
            for (const url of imageUrls) {
                deltaContent += this._renderImage(url) + "\n";
            }

            if (mr.metadata?.llm_info?.modelHash) {
                state.fingerprint = mr.metadata.llm_info.modelHash;
            }
        }

        // 4. 处理卡片附件
        if (resp.cardAttachment) {
            const card = resp.cardAttachment;
            if (card.jsonData) {
                try {
                    const cardData = JSON.parse(card.jsonData);
                    const original = cardData.image?.original;
                    const title = cardData.image?.title || "image";
                    if (original) {
                        deltaContent += `![${title}](${original})\n`;
                    }
                } catch (e) {
                    // 忽略 JSON 解析错误
                }
            }
        }

        // 5. 处理普通 Token 和 思考状态
        if (resp.token !== undefined && resp.token !== null) {
            const token = resp.token;
            const filtered = this._filterToken(token, responseId);
            const isThinking = !!resp.isThinking;
            const inThink = isThinking || state.image_think_active || state.video_think_active;

            if (inThink) {
                deltaReasoning += filtered;
            } else {
                // 工具调用抑制逻辑：不向客户端输出 <tool_call> 块及其内容
                let outputToken = filtered;
                
                // 简单的状态切换检测
                if (outputToken.includes('<tool_call>')) {
                    state.in_tool_call = true;
                    state.has_tool_call = true;
                    // 移除标签之后的部分（如果有）
                    outputToken = outputToken.split('<tool_call>')[0];
                } else if (state.in_tool_call && outputToken.includes('</tool_call>')) {
                    state.in_tool_call = false;
                    // 只保留标签之后的部分
                    outputToken = outputToken.split('</tool_call>')[1] || "";
                } else if (state.in_tool_call) {
                    // 处于块内，完全抑制
                    outputToken = "";
                }

                deltaContent += outputToken;
                
                // 将内容加入 buffer 用于最终解析工具调用
                state.content_buffer += filtered;
            }
            state.last_is_thinking = isThinking;
        }

        if (deltaContent || deltaReasoning) {
            const delta = {};
            if (deltaContent) delta.content = deltaContent;
            if (deltaReasoning) delta.reasoning_content = deltaReasoning;

            chunks.push({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                system_fingerprint: state.fingerprint,
                choices: [{
                    index: 0,
                    delta: delta,
                    finish_reason: null
                }]
            });
        }

        return chunks.length > 0 ? chunks : null;
    }
}
