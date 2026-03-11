import jestGlobals from '@jest/globals';
import {
    GeminiApiService,
    buildGeminiIpCandidateSequence,
    classifyGeminiFixedIpError,
    classifyGeminiFixedIpResponse,
} from '../src/providers/gemini/gemini-core.js';

const { jest } = jestGlobals;

function createService(overrides = {}) {
    return new GeminiApiService({
        HOST: '0.0.0.0',
        REQUEST_MAX_RETRIES: 1,
        REQUEST_BASE_DELAY: 1,
        GEMINI_FIXED_IP_ROTATION_ENABLED: true,
        GEMINI_FIXED_IP_RACE_ENABLED: false,
        GEMINI_FIXED_IP_RACE_REQUEST_DELAY_MS: 0,
        GEMINI_FIXED_IP_RACE_FALLBACK_TO_DNS: false,
        GEMINI_FIXED_IP_RACE_DISABLE_COOLDOWN: false,
        GEMINI_FIXED_IPS: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
        ...overrides,
    });
}

function createResponse(status, data, config = {}) {
    return {
        status,
        data,
        config,
    };
}

function createRequestOptions(url = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', model = undefined) {
    return {
        url: new URL(url),
        method: 'POST',
        headers: new Headers(),
        responseType: 'json',
        validateStatus: () => true,
        _geminiModel: model,
    };
}

function createDelayedAdapterResult(requestOptions, delayMs, factory) {
    return new Promise((resolve, reject) => {
        const finish = () => {
            try {
                resolve(factory());
            } catch (error) {
                reject(error);
            }
        };

        const timer = setTimeout(finish, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            const error = new Error('The operation was aborted.');
            error.code = 'AbortError';
            reject(error);
        };

        if (requestOptions.signal?.aborted) {
            onAbort();
            return;
        }

        requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    });
}

describe('Gemini fixed IP rotation helpers', () => {
    test('appends the braille blank prompt and normalizes non-stream responses when enabled', async () => {
        const service = createService({ GEMINI_REPLACE_SPACE: true });
        jest.spyOn(service, 'isExpiryDateNear').mockReturnValue(false);
        service.callApi = jest.fn().mockResolvedValue({
            response: {
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'hello\u2800world' }],
                    },
                    finishReason: 'STOP',
                }],
            },
        });

        const requestBody = {
            systemInstruction: {
                parts: [{ text: 'Base system prompt.' }],
            },
            contents: [{
                role: 'user',
                parts: [{ text: 'Hi' }],
            }],
        };

        const response = await service.generateContent('gemini-2.5-flash', requestBody);
        const apiRequest = service.callApi.mock.calls[0][1];
        const systemText = apiRequest.request.systemInstruction.parts[0].text;

        expect(systemText).toContain('Base system prompt.');
        expect(systemText).toContain('U+2800 BRAILLE PATTERN BLANK');
        expect(response.candidates[0].content.parts[0].text).toBe('hello world');
    });

    test('preserves existing multipart system instructions and assigns a role when appending the prompt', async () => {
        const service = createService({ GEMINI_REPLACE_SPACE: true });
        jest.spyOn(service, 'isExpiryDateNear').mockReturnValue(false);
        service.callApi = jest.fn().mockResolvedValue({
            response: {
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'hello\u2800world' }],
                    },
                    finishReason: 'STOP',
                }],
            },
        });

        await service.generateContent('gemini-2.5-flash', {
            systemInstruction: {
                parts: [
                    { text: 'Base system prompt.' },
                    { inlineData: { mimeType: 'text/plain', data: 'ZXhhbXBsZQ==' } },
                    { text: 'Keep this instruction too.' },
                ],
            },
            contents: [{
                role: 'user',
                parts: [{ text: 'Hi' }],
            }],
        });

        const apiRequest = service.callApi.mock.calls[0][1];
        const instruction = apiRequest.request.systemInstruction;

        expect(instruction.role).toBe('user');
        expect(instruction.parts[0]).toEqual({ text: 'Base system prompt.' });
        expect(instruction.parts[1]).toEqual({ inlineData: { mimeType: 'text/plain', data: 'ZXhhbXBsZQ==' } });
        expect(instruction.parts[2].text).toContain('Keep this instruction too.');
        expect(instruction.parts[2].text).toContain('U+2800 BRAILLE PATTERN BLANK');
    });

    test('creates a default system instruction with user role when the feature is enabled', async () => {
        const service = createService({ GEMINI_REPLACE_SPACE: true });
        jest.spyOn(service, 'isExpiryDateNear').mockReturnValue(false);
        service.callApi = jest.fn().mockResolvedValue({
            response: {
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'hello\u2800world' }],
                    },
                    finishReason: 'STOP',
                }],
            },
        });

        await service.generateContent('gemini-2.5-flash', {
            contents: [{
                role: 'user',
                parts: [{ text: 'Hi' }],
            }],
        });

        const apiRequest = service.callApi.mock.calls[0][1];

        expect(apiRequest.request.systemInstruction.role).toBe('user');
        expect(apiRequest.request.systemInstruction.parts).toEqual([
            expect.objectContaining({
                text: expect.stringContaining('U+2800 BRAILLE PATTERN BLANK')
            })
        ]);
    });

    test('keeps braille blanks untouched when the feature is disabled', async () => {
        const service = createService();
        jest.spyOn(service, 'isExpiryDateNear').mockReturnValue(false);
        service.callApi = jest.fn().mockResolvedValue({
            response: {
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'hello\u2800world' }],
                    },
                    finishReason: 'STOP',
                }],
            },
        });

        const requestBody = {
            systemInstruction: {
                parts: [{ text: 'Base system prompt.' }],
            },
            contents: [{
                role: 'user',
                parts: [{ text: 'Hi' }],
            }],
        };

        const response = await service.generateContent('gemini-2.5-flash', requestBody);
        const apiRequest = service.callApi.mock.calls[0][1];

        expect(apiRequest.request.systemInstruction.parts[0].text).toBe('Base system prompt.');
        expect(response.candidates[0].content.parts[0].text).toBe('hello\u2800world');
    });

    test('normalizes stream chunks when the feature is enabled', async () => {
        const service = createService({ GEMINI_REPLACE_SPACE: true });
        jest.spyOn(service, 'isExpiryDateNear').mockReturnValue(false);
        service.streamApi = jest.fn().mockImplementation(async function* () {
            yield {
                response: {
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: 'stream\u2800chunk' }],
                        },
                        finishReason: 'STOP',
                    }],
                },
            };
        });

        const chunks = [];
        for await (const chunk of service.generateContentStream('gemini-2.5-flash', {
            contents: [{
                role: 'user',
                parts: [{ text: 'Hi' }],
            }],
        })) {
            chunks.push(chunk);
        }

        const apiRequest = service.streamApi.mock.calls[0][1];
        const systemText = apiRequest.request.systemInstruction.parts[0].text;

        expect(systemText).toContain('U+2800 BRAILLE PATTERN BLANK');
        expect(chunks[0].candidates[0].content.parts[0].text).toBe('stream chunk');
    });

    test('builds candidate list with preferred IP first and deduplicated', () => {
        expect(buildGeminiIpCandidateSequence(['1.1.1.1', '2.2.2.2', '1.1.1.1'], '2.2.2.2'))
            .toEqual(['2.2.2.2', '1.1.1.1']);
    });

    test('classifies no-capacity and quota-exhausted responses differently', () => {
        expect(classifyGeminiFixedIpResponse({
            status: 429,
            data: { error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' } },
        })).toMatchObject({ action: 'rotate', reason: '429-no-capacity' });

        expect(classifyGeminiFixedIpResponse({
            status: 429,
            data: { error: { message: 'You have exhausted your capacity on this model. Your quota will reset after 18s.' } },
        })).toMatchObject({ action: 'stop', reason: '429-quota-exhausted' });

        expect(classifyGeminiFixedIpResponse({
            status: 500,
            data: { error: { message: 'Internal Server Error' } },
        })).toMatchObject({ action: 'rotate', reason: '500-server-error' });
    });

    test('treats abort errors as rotatable transport failures', () => {
        const error = new Error('The operation was aborted.');
        error.code = 'AbortError';

        expect(classifyGeminiFixedIpError(error)).toMatchObject({ action: 'rotate' });
    });

    test('returns an address array when Node requests lookup results with all=true', async () => {
        const service = createService();
        const agent = service._getFixedIpAgent('cloudcode-pa.googleapis.com', '1.1.1.1');

        const addresses = await new Promise((resolve, reject) => {
            agent.options.lookup('cloudcode-pa.googleapis.com', { all: true }, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result);
            });
        });

        expect(addresses).toEqual([{ address: '1.1.1.1', family: 4 }]);
    });

    test('installs a gaxios request interceptor that injects the fixed-IP adapter', async () => {
        const service = createService();
        const interceptors = Array.from(service.authClient.transporter.interceptors.request.values());
        let prepared = createRequestOptions();
        for (const interceptor of interceptors) {
            if (typeof interceptor?.resolved === 'function') {
                prepared = await interceptor.resolved(prepared);
            }
        }

        expect(typeof prepared.adapter).toBe('function');
    });

    test('enables race mode by default when config does not override it', () => {
        const service = new GeminiApiService({
            HOST: '0.0.0.0',
            REQUEST_MAX_RETRIES: 1,
            REQUEST_BASE_DELAY: 1,
            GEMINI_FIXED_IP_ROTATION_ENABLED: true,
            GEMINI_FIXED_IPS: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
        });

        expect(service.fixedIpRaceEnabled).toBe(true);
        expect(service.fixedIpRaceFallbackToDns).toBe(false);
        expect(service.fixedIpRaceDisableCooldown).toBe(true);
        expect(service.fixedIpRaceRounds).toBe(3);
        expect(service.fixedIpRaceConcurrency).toBe(1);
        expect(service.fixedIpRaceRequestDelayMs).toBe(2000);
    });

    test('tracks no-capacity cooldowns per model instead of globally per hostname', () => {
        const service = createService();
        service.fixedIpPreferredByHostname.set('cloudcode-pa.googleapis.com', '1.1.1.1');
        service._markFixedIpCooldown(
            'cloudcode-pa.googleapis.com',
            '1.1.1.1',
            '429-no-capacity',
            'gemini-3.1-pro-preview',
            60000
        );

        expect(service._getFixedIpCandidates('cloudcode-pa.googleapis.com', 'gemini-3.1-pro-preview'))
            .toEqual(['2.2.2.2', '3.3.3.3']);
        expect(service._getFixedIpCandidates('cloudcode-pa.googleapis.com', 'gemini-3-flash-preview'))
            .toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
    });

    test('prefers the last successful IP per model when one is known', () => {
        const service = createService();
        service.fixedIpPreferredByHostname.set('cloudcode-pa.googleapis.com', '1.1.1.1');
        service._rememberSuccessfulFixedIp('cloudcode-pa.googleapis.com', '2.2.2.2', 'gemini-3.1-pro-preview');

        expect(service._getFixedIpCandidates('cloudcode-pa.googleapis.com', 'gemini-3.1-pro-preview')[0]).toBe('2.2.2.2');
        expect(service._getFixedIpCandidates('cloudcode-pa.googleapis.com', 'gemini-3-flash-preview')[0]).toBe('1.1.1.1');
    });

    test('returns no fixed-IP candidates while every candidate is on cooldown for a model', () => {
        const service = createService();

        for (const ip of service.fixedIpList) {
            service._markFixedIpCooldown(
                'cloudcode-pa.googleapis.com',
                ip,
                '429-no-capacity',
                'gemini-3.1-pro-preview',
                60000
            );
        }

        expect(service._getFixedIpCandidates('cloudcode-pa.googleapis.com', 'gemini-3.1-pro-preview'))
            .toEqual([]);
    });
});

describe('Gemini fixed IP rotation transport', () => {
    test('switches to the next IP when the current IP returns no-capacity and caches the winner', async () => {
        const service = createService();
        const seenIps = [];
        const defaultAdapter = jest.fn(async (requestOptions) => {
            seenIps.push(requestOptions._geminiFixedIp);
            if (requestOptions._geminiFixedIp === '1.1.1.1') {
                return createResponse(
                    429,
                    { error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' } },
                    requestOptions
                );
            }

            return createResponse(200, { ok: true }, requestOptions);
        });

        const response = await service._executeWithFixedIpRotation(createRequestOptions(undefined, 'gemini-3.1-pro-preview'), defaultAdapter);

        expect(response.status).toBe(200);
        expect(seenIps).toEqual(['1.1.1.1', '2.2.2.2']);
        expect(service.fixedIpPreferredByModelHostname.get('cloudcode-pa.googleapis.com|gemini-3.1-pro-preview')).toBe('2.2.2.2');
    });

    test('stops rotating once quota exhaustion is reached on models without per-IP quota rotation', async () => {
        const service = createService();
        service.fixedIpPreferredByHostname.set('cloudcode-pa.googleapis.com', '2.2.2.2');

        const defaultAdapter = jest.fn(async (requestOptions) => {
            return createResponse(
                429,
                { error: { message: 'You have exhausted your capacity on this model. Your quota will reset after 18s.' } },
                requestOptions
            );
        });

        await expect(service._executeWithFixedIpRotation(createRequestOptions(), defaultAdapter))
            .rejects
            .toMatchObject({
                response: {
                    status: 429,
                    data: {
                        error: {
                            message: expect.stringContaining('You have exhausted your capacity'),
                        },
                    },
                },
            });

        expect(defaultAdapter).toHaveBeenCalledTimes(1);
        expect(defaultAdapter.mock.calls[0][0]._geminiFixedIp).toBe('2.2.2.2');
    });

    test('tries the next fixed IP after quota exhaustion for gemini-3.1-pro-preview', async () => {
        const service = createService();
        const seenIps = [];
        const defaultAdapter = jest.fn(async (requestOptions) => {
            seenIps.push(requestOptions._geminiFixedIp);
            if (requestOptions._geminiFixedIp === '1.1.1.1') {
                return createResponse(
                    429,
                    { error: { message: 'You have exhausted your capacity on this model. Your quota will reset after 18s.' } },
                    requestOptions
                );
            }

            return createResponse(200, { ok: true }, requestOptions);
        });

        const response = await service._executeWithFixedIpRotation(
            createRequestOptions(undefined, 'gemini-3.1-pro-preview'),
            defaultAdapter
        );

        expect(response.status).toBe(200);
        expect(seenIps).toEqual(['1.1.1.1', '2.2.2.2']);
        expect(service.fixedIpPreferredByModelHostname.get('cloudcode-pa.googleapis.com|gemini-3.1-pro-preview')).toBe('2.2.2.2');
    });

    test('switches IPs after abort/network failures', async () => {
        const service = createService();
        const seenIps = [];
        const defaultAdapter = jest.fn(async (requestOptions) => {
            seenIps.push(requestOptions._geminiFixedIp);
            if (requestOptions._geminiFixedIp === '1.1.1.1') {
                const error = new Error('The operation was aborted.');
                error.code = 'AbortError';
                throw error;
            }

            return createResponse(200, { ok: true }, requestOptions);
        });

        const response = await service._executeWithFixedIpRotation(createRequestOptions(), defaultAdapter);

        expect(response.status).toBe(200);
        expect(seenIps).toEqual(['1.1.1.1', '2.2.2.2']);
    });

    test('falls back to default transport when every fixed IP is cooling down for the model', async () => {
        const service = createService();
        for (const ip of service.fixedIpList) {
            service._markFixedIpCooldown(
                'cloudcode-pa.googleapis.com',
                ip,
                '429-no-capacity',
                'gemini-3.1-pro-preview',
                60000
            );
        }

        const defaultAdapter = jest.fn(async (requestOptions) => {
            expect(requestOptions._geminiFixedIp).toBeUndefined();
            return createResponse(200, { ok: true }, requestOptions);
        });

        const response = await service._executeWithFixedIpRotation(
            createRequestOptions(undefined, 'gemini-3.1-pro-preview'),
            defaultAdapter
        );

        expect(response.status).toBe(200);
        expect(defaultAdapter).toHaveBeenCalledTimes(1);
    });

    test('race mode returns the first successful fixed IP without waiting for slower attempts', async () => {
        const service = createService({
            GEMINI_FIXED_IP_RACE_ENABLED: true,
            GEMINI_FIXED_IP_RACE_CONCURRENCY: 2,
            GEMINI_FIXED_IP_RACE_ROUNDS: 2,
            GEMINI_FIXED_IP_RACE_FALLBACK_TO_DNS: false,
        });
        const seenIps = [];
        const defaultAdapter = jest.fn((requestOptions) => {
            seenIps.push(requestOptions._geminiFixedIp ?? 'dns');

            if (requestOptions._geminiFixedIp === '1.1.1.1') {
                return createDelayedAdapterResult(requestOptions, 50, () =>
                    createResponse(
                        429,
                        { error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' } },
                        requestOptions
                    )
                );
            }

            if (requestOptions._geminiFixedIp === '2.2.2.2') {
                return createDelayedAdapterResult(requestOptions, 5, () =>
                    createResponse(200, { ok: true }, requestOptions)
                );
            }

            return createDelayedAdapterResult(requestOptions, 5, () =>
                createResponse(500, { error: { message: 'should not be reached' } }, requestOptions)
            );
        });

        const response = await service._executeWithFixedIpRotation(
            createRequestOptions(undefined, 'gemini-3.1-pro-preview'),
            defaultAdapter
        );

        expect(response.status).toBe(200);
        expect(seenIps).toEqual(['1.1.1.1', '2.2.2.2']);
        expect(service.fixedIpPreferredByModelHostname.get('cloudcode-pa.googleapis.com|gemini-3.1-pro-preview')).toBe('2.2.2.2');
    });

    test('stops stream retries after the caller aborts during quota backoff', async () => {
        const service = createService({
            REQUEST_MAX_RETRIES: 3,
            REQUEST_BASE_DELAY: 200,
        });
        const controller = new AbortController();
        const rateLimitError = new Error('Too many requests');
        rateLimitError.response = {
            status: 429,
            data: { error: { message: 'Too many requests' } },
        };

        service.authClient.request = jest.fn(async (requestOptions) => {
            expect(requestOptions.signal).toBe(controller.signal);
            throw rateLimitError;
        });

        const consumePromise = (async () => {
            for await (const _chunk of service.streamApi(
                'streamGenerateContent',
                {
                    model: 'gemini-3-flash-preview',
                    project: 'project-id',
                    request: { contents: [] },
                },
                false,
                0,
                controller.signal
            )) {
                // no-op
            }
        })();

        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();

        await expect(consumePromise).rejects.toMatchObject({ code: 'AbortError' });
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
    });

    test('race mode returns the upstream retryable error after exhausting rounds when DNS fallback is disabled', async () => {
        const service = createService({
            GEMINI_FIXED_IP_RACE_ENABLED: true,
            GEMINI_FIXED_IP_RACE_CONCURRENCY: 2,
            GEMINI_FIXED_IP_RACE_ROUNDS: 2,
            GEMINI_FIXED_IP_RACE_FALLBACK_TO_DNS: false,
        });
        const defaultAdapter = jest.fn(async (requestOptions) => createResponse(
            429,
            { error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' } },
            requestOptions
        ));

        await expect(service._executeWithFixedIpRotation(
            createRequestOptions(undefined, 'gemini-3.1-pro-preview'),
            defaultAdapter
        )).rejects.toMatchObject({
            response: {
                status: 429,
            },
        });

        expect(defaultAdapter).toHaveBeenCalledTimes(3);
        expect(defaultAdapter.mock.calls.every(([requestOptions]) => Boolean(requestOptions._geminiFixedIp))).toBe(true);
    });

    test('race mode can repeat the same IPs across rounds when cooldown is disabled', async () => {
        const service = createService({
            GEMINI_FIXED_IP_RACE_ENABLED: true,
            GEMINI_FIXED_IP_RACE_CONCURRENCY: 2,
            GEMINI_FIXED_IP_RACE_ROUNDS: 2,
            GEMINI_FIXED_IP_RACE_FALLBACK_TO_DNS: false,
            GEMINI_FIXED_IP_RACE_DISABLE_COOLDOWN: true,
        });
        const seenIps = [];
        const defaultAdapter = jest.fn(async (requestOptions) => {
            seenIps.push(requestOptions._geminiFixedIp);
            return createResponse(
                429,
                { error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' } },
                requestOptions
            );
        });

        await expect(service._executeWithFixedIpRotation(
            createRequestOptions(undefined, 'gemini-3.1-pro-preview'),
            defaultAdapter
        )).rejects.toMatchObject({
            response: {
                status: 429,
            },
        });

        expect(seenIps).toEqual([
            '1.1.1.1',
            '2.2.2.2',
            '3.3.3.3',
            '1.1.1.1',
            '2.2.2.2',
            '3.3.3.3',
        ]);
        expect(defaultAdapter).toHaveBeenCalledTimes(6);
        expect(service._getBlockedFixedIps('cloudcode-pa.googleapis.com', 'gemini-3.1-pro-preview')).toEqual([]);
    });

    test('race mode falls back to DNS after exhausting rounds when configured', async () => {
        const service = createService({
            GEMINI_FIXED_IP_RACE_ENABLED: true,
            GEMINI_FIXED_IP_RACE_CONCURRENCY: 2,
            GEMINI_FIXED_IP_RACE_ROUNDS: 1,
            GEMINI_FIXED_IP_RACE_FALLBACK_TO_DNS: true,
        });
        const seenIps = [];
        const defaultAdapter = jest.fn(async (requestOptions) => {
            seenIps.push(requestOptions._geminiFixedIp ?? 'dns');
            if (requestOptions._geminiFixedIp) {
                return createResponse(
                    429,
                    { error: { message: 'No capacity available for model gemini-3.1-pro-preview on the server' } },
                    requestOptions
                );
            }

            return createResponse(200, { ok: true }, requestOptions);
        });

        const response = await service._executeWithFixedIpRotation(
            createRequestOptions(undefined, 'gemini-3.1-pro-preview'),
            defaultAdapter
        );

        expect(response.status).toBe(200);
        expect(seenIps).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3', 'dns']);
        expect(defaultAdapter.mock.calls.at(-1)[0]._geminiFixedIp).toBeUndefined();
    });
});

describe('Gemini unary requests', () => {
    test('uses generateContent for unary calls', async () => {
        const service = createService();
        service.projectId = 'project-id';
        service.isExpiryDateNear = jest.fn(() => false);
        service.callApi = jest.fn(async (method, payload) => {
            expect(method).toBe('generateContent');
            expect(payload).toMatchObject({
                model: 'gemini-3-flash-preview',
                project: 'project-id',
                request: {
                    contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
                },
            });

            return {
                response: {
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: 'Hello world' }],
                        },
                        finishReason: 'STOP',
                    }],
                    usageMetadata: {
                        promptTokenCount: 1,
                        candidatesTokenCount: 1,
                        totalTokenCount: 2,
                    },
                },
            };
        });

        const response = await service.generateContent('gemini-3-flash-preview', {
            contents: [{ parts: [{ text: 'Hi' }] }],
        });

        expect(service.callApi).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{ text: 'Hello world' }],
                },
                finishReason: 'STOP',
            }],
            usageMetadata: {
                totalTokenCount: 2,
            },
        });
    });

    test('adds a GeminiCLI-style user agent to Code Assist requests', async () => {
        const service = createService();
        service.authClient.request = jest.fn(async () => ({ data: { ok: true } }));

        await service.callApi('loadCodeAssist', { model: 'gemini-3-flash-preview' });

        expect(service.authClient.request).toHaveBeenCalledTimes(1);
        expect(service.authClient.request.mock.calls[0][0].headers['User-Agent'])
            .toContain('GeminiCLI/');
        expect(service.authClient.request.mock.calls[0][0].headers['User-Agent'])
            .toContain('/gemini-3-flash-preview ');
    });

    test('assigns unique session IDs to unary requests with identical user text', async () => {
        const service = createService();
        const sessionIds = [];
        service.projectId = 'project-id';
        service.isExpiryDateNear = jest.fn(() => false);
        service.callApi = jest.fn(async (_method, payload) => {
            sessionIds.push(payload.request.session_id);
            return {
                response: {
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: 'ok' }],
                        },
                        finishReason: 'STOP',
                    }],
                },
            };
        });

        await service.generateContent('gemini-3-flash-preview', {
            contents: [{ parts: [{ text: 'hello' }] }],
        });
        await service.generateContent('gemini-3-flash-preview', {
            contents: [{ parts: [{ text: 'hello' }] }],
        });

        expect(sessionIds).toHaveLength(2);
        expect(sessionIds[0]).toMatch(/^session-/);
        expect(sessionIds[1]).toMatch(/^session-/);
        expect(sessionIds[0]).not.toBe(sessionIds[1]);
    });

    test('assigns unique session IDs to image-only unary requests', async () => {
        const service = createService();
        const sessionIds = [];
        service.projectId = 'project-id';
        service.isExpiryDateNear = jest.fn(() => false);
        service.callApi = jest.fn(async (_method, payload) => {
            sessionIds.push(payload.request.session_id);
            return {
                response: {
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: 'ok' }],
                        },
                        finishReason: 'STOP',
                    }],
                },
            };
        });

        await service.generateContent('gemini-3-flash-preview', {
            contents: [{
                parts: [{
                    inlineData: {
                        mimeType: 'image/png',
                        data: 'aGVsbG8=',
                    },
                }],
            }],
        });
        await service.generateContent('gemini-3-flash-preview', {
            contents: [{
                parts: [{
                    inlineData: {
                        mimeType: 'image/png',
                        data: 'aGVsbG8=',
                    },
                }],
            }],
        });

        expect(sessionIds).toHaveLength(2);
        expect(sessionIds[0]).toMatch(/^session-/);
        expect(sessionIds[1]).toMatch(/^session-/);
        expect(sessionIds[0]).not.toBe(sessionIds[1]);
    });
});

describe('Gemini anti-truncation', () => {
    test('preserves the same session and accumulates continuation text across retries', async () => {
        const service = createService();
        const seenRequests = [];
        service.projectId = 'project-id';
        service.isExpiryDateNear = jest.fn(() => false);
        service.streamApi = jest.fn((_method, apiRequest) => {
            seenRequests.push(apiRequest);
            const iteration = seenRequests.length;
            const chunksByIteration = [
                [{
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: 'Hello ' }],
                            },
                            finishReason: 'MAX_TOKENS',
                        }],
                    },
                }],
                [{
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: 'world' }],
                            },
                            finishReason: 'MAX_TOKENS',
                        }],
                    },
                }],
                [{
                    response: {
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ text: '!' }],
                            },
                            finishReason: 'STOP',
                        }],
                    },
                }],
            ];

            return (async function* () {
                for (const chunk of chunksByIteration[iteration - 1]) {
                    yield chunk;
                }
            })();
        });

        const responses = [];
        for await (const response of service.generateContentStream('anti-gemini-3-flash-preview', {
            contents: [{ parts: [{ text: 'Say hello' }] }],
        })) {
            responses.push(response);
        }

        expect(responses).toHaveLength(3);
        expect(service.streamApi).toHaveBeenCalledTimes(3);
        expect(seenRequests[0].request.session_id).toMatch(/^session-/);
        expect(seenRequests[1].request.session_id).toBe(seenRequests[0].request.session_id);
        expect(seenRequests[2].request.session_id).toBe(seenRequests[0].request.session_id);
        expect(seenRequests[1].request.contents[1]).toEqual({
            role: 'model',
            parts: [{ text: 'Hello ' }],
        });
        expect(seenRequests[2].request.contents[1]).toEqual({
            role: 'model',
            parts: [{ text: 'Hello world' }],
        });
        expect(seenRequests[2].request.contents[2]).toEqual({
            role: 'user',
            parts: [{ text: 'Please continue from where you left off.' }],
        });
    });
});

describe('Gemini initialization', () => {
    test('refreshes access token before project discovery when only refresh_token is loaded', async () => {
        const service = createService({ PROJECT_ID: '' });
        service.loadCredentials = jest.fn(async () => {
            service.authClient.setCredentials({ refresh_token: 'refresh-token' });
        });
        service.initializeAuth = jest.fn(async () => {
            service.authClient.setCredentials({
                refresh_token: 'refresh-token',
                access_token: 'access-token',
            });
        });
        service.discoverProjectAndModels = jest.fn(async () => 'discovered-project');

        await service.initialize();

        expect(service.initializeAuth).toHaveBeenCalledWith(false);
        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(1);
        expect(service.projectId).toBe('discovered-project');
    });

    test('fails early with a clear error when project discovery has no OAuth credentials', async () => {
        const service = createService({ PROJECT_ID: '' });
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn();

        await expect(service.initialize()).rejects.toThrow(
            'Could not discover a valid Google Cloud Project ID because no Gemini OAuth credentials were loaded.'
        );

        expect(service.discoverProjectAndModels).not.toHaveBeenCalled();
    });
});
