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

describe('Gemini fixed IP rotation helpers', () => {
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
