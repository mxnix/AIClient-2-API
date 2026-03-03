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

function createRequestOptions(url = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
    return {
        url: new URL(url),
        method: 'POST',
        responseType: 'json',
        validateStatus: () => true,
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

        const response = await service._executeWithFixedIpRotation(createRequestOptions(), defaultAdapter);

        expect(response.status).toBe(200);
        expect(seenIps).toEqual(['1.1.1.1', '2.2.2.2']);
        expect(service.fixedIpPreferredByHostname.get('cloudcode-pa.googleapis.com')).toBe('2.2.2.2');
    });

    test('stops rotating once quota exhaustion is reached and keeps current retry flow intact', async () => {
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
});
