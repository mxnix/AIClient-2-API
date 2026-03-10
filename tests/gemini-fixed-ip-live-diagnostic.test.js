import jestGlobals from '@jest/globals';
import { promises as fs } from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { fetch } from 'undici';
import {
    DEFAULT_GEMINI_FIXED_IPS,
    GeminiApiService,
    classifyGeminiFixedIpError,
    classifyGeminiFixedIpResponse,
} from '../src/providers/gemini/gemini-core.js';

const { describe, test, expect } = jestGlobals;

const RUN_LIVE_DIAGNOSTIC = process.env.RUN_REAL_GEMINI_FIXED_IP_DIAGNOSTIC === '1';
const liveTest = RUN_LIVE_DIAGNOSTIC ? test : test.skip;
const DIAGNOSTIC_TIMEOUT_MS = parsePositiveInteger(process.env.GEMINI_DIAGNOSTIC_TIMEOUT_MS, 20000);
const DIAGNOSTIC_IP_COUNT = parsePositiveInteger(process.env.GEMINI_DIAGNOSTIC_IP_COUNT, 3);
const DIAGNOSTIC_MODEL = process.env.GEMINI_DIAGNOSTIC_MODEL || 'gemini-2.5-flash';
const DIAGNOSTIC_PROMPT = process.env.GEMINI_DIAGNOSTIC_PROMPT || 'Reply with exactly OK.';

function parsePositiveInteger(rawValue, fallbackValue) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallbackValue;
    }

    return parsed;
}

function parseIpList(rawValue) {
    if (!rawValue) {
        return [];
    }

    const uniqueIps = [];
    for (const entry of String(rawValue).split(/[\s,]+/)) {
        const candidate = entry.trim();
        if (!candidate || uniqueIps.includes(candidate)) {
            continue;
        }

        uniqueIps.push(candidate);
    }

    return uniqueIps;
}

function sampleRandomIps(ipPool, count) {
    const shuffled = [...ipPool];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }

    return shuffled.slice(0, Math.min(count, shuffled.length));
}

function getCandidateIpPool() {
    const configuredIps = parseIpList(
        process.env.GEMINI_DIAGNOSTIC_FIXED_IPS ||
        process.env.GEMINI_FIXED_IPS
    );

    if (configuredIps.length > 0) {
        return configuredIps;
    }

    return [...DEFAULT_GEMINI_FIXED_IPS];
}

function getOauthFilePath() {
    return process.env.GEMINI_DIAGNOSTIC_OAUTH_FILE ||
        process.env.GEMINI_OAUTH_CREDS_FILE_PATH ||
        '';
}

function parsePathList(rawValue) {
    if (!rawValue) {
        return [];
    }

    const uniquePaths = [];
    for (const entry of String(rawValue).split(/[\r\n,;]+/)) {
        const candidate = entry.trim();
        if (!candidate || uniquePaths.includes(candidate)) {
            continue;
        }

        uniquePaths.push(candidate);
    }

    return uniquePaths;
}

async function discoverOauthFilePaths() {
    const explicitList = parsePathList(process.env.GEMINI_DIAGNOSTIC_OAUTH_FILES);
    if (explicitList.length > 0) {
        return explicitList;
    }

    const explicitSinglePath = getOauthFilePath();
    if (explicitSinglePath) {
        return [explicitSinglePath];
    }

    const projectGeminiDir = path.join(process.cwd(), 'configs', 'gemini');
    try {
        const entries = await fs.readdir(projectGeminiDir, { withFileTypes: true });
        const discovered = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('_oauth_creds.json')) {
                continue;
            }

            const fullPath = path.join(projectGeminiDir, entry.name);
            const stats = await fs.stat(fullPath);
            discovered.push({
                fullPath,
                mtimeMs: stats.mtimeMs,
            });
        }

        if (discovered.length > 0) {
            discovered.sort((left, right) => right.mtimeMs - left.mtimeMs);
            return discovered.map((item) => item.fullPath);
        }
    } catch {
        // Fall through to the legacy default path.
    }

    return [path.join(os.homedir(), '.gemini', 'oauth_creds.json')];
}

function extractErrorText(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value?.error?.message === 'string') {
        return value.error.message;
    }

    if (typeof value?.message === 'string') {
        return value.message;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function summarizeValue(value, maxLength = 220) {
    const text = extractErrorText(value);
    if (!text) {
        return '';
    }

    return text.length <= maxLength
        ? text
        : `${text.slice(0, maxLength - 3)}...`;
}

function extractProjectId(loadCodeAssistPayload) {
    const rawProject = loadCodeAssistPayload?.cloudaicompanionProject;
    if (typeof rawProject === 'string' && rawProject.trim()) {
        return rawProject.trim();
    }

    if (typeof rawProject?.id === 'string' && rawProject.id.trim()) {
        return rawProject.id.trim();
    }

    return '';
}

function createGeminiServiceForIp(fixedIp, projectId = '', oauthFilePath = '') {
    return new GeminiApiService({
        HOST: '0.0.0.0',
        PROJECT_ID: projectId,
        REQUEST_MAX_RETRIES: -1,
        REQUEST_BASE_DELAY: 1,
        GEMINI_FIXED_IP_ROTATION_ENABLED: true,
        GEMINI_FIXED_IP_RACE_ENABLED: false,
        GEMINI_FIXED_IPS: [fixedIp],
        GEMINI_BASE_URL: process.env.GEMINI_DIAGNOSTIC_BASE_URL || process.env.GEMINI_BASE_URL,
        GEMINI_OAUTH_CREDS_BASE64: process.env.GEMINI_DIAGNOSTIC_OAUTH_BASE64 || process.env.GEMINI_OAUTH_CREDS_BASE64,
        GEMINI_OAUTH_CREDS_FILE_PATH: oauthFilePath,
    });
}

async function describeCredentialSource(oauthFilePath = '') {
    const hasBase64Creds = Boolean(
        process.env.GEMINI_DIAGNOSTIC_OAUTH_BASE64 ||
        process.env.GEMINI_OAUTH_CREDS_BASE64
    );

    if (hasBase64Creds) {
        return {
            kind: 'base64',
            location: 'GEMINI_DIAGNOSTIC_OAUTH_BASE64/GEMINI_OAUTH_CREDS_BASE64',
            exists: true,
        };
    }

    const resolvedPath = oauthFilePath || path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    try {
        await fs.access(resolvedPath);
        return {
            kind: 'file',
            location: resolvedPath,
            exists: true,
        };
    } catch {
        return {
            kind: 'file',
            location: resolvedPath,
            exists: false,
        };
    }
}

async function refreshGeminiAccessToken(service, sourceDescription) {
    const tokenEndpoint = service.authClient.endpoints.oauth2TokenUrl;
    const clientId = service.authClient._clientId;
    const clientSecret = service.authClient._clientSecret;
    const refreshToken = service.authClient.credentials.refresh_token;

    const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }).toString(),
    });

    const rawBody = await response.text();
    let parsedBody = null;
    try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
        parsedBody = rawBody;
    }

    if (!response.ok) {
        throw new Error(
            `OAuth refresh endpoint returned ${response.status} for ${sourceDescription}: ${summarizeValue(parsedBody || rawBody)}`
        );
    }

    const refreshedCredentials = typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : {};
    const expiresInSeconds = Number(refreshedCredentials.expires_in);
    const expiryDate = Number.isFinite(expiresInSeconds)
        ? Date.now() + (expiresInSeconds * 1000)
        : service.authClient.credentials.expiry_date;

    service.authClient.setCredentials({
        ...service.authClient.credentials,
        ...refreshedCredentials,
        ...(Number.isFinite(expiryDate) ? { expiry_date: expiryDate } : {}),
        refresh_token: service.authClient.credentials.refresh_token,
    });
}

async function ensureAccessToken(service, oauthFilePath = '') {
    const credentialSource = await describeCredentialSource(oauthFilePath);
    await service.loadCredentials();

    const hasAccessToken = Boolean(service.authClient.credentials.access_token);
    const hasRefreshToken = Boolean(service.authClient.credentials.refresh_token);
    const expiryDate = Number(service.authClient.credentials.expiry_date);
    const tokenExpired = Number.isFinite(expiryDate) && expiryDate <= Date.now();
    const shouldForceRefresh = process.env.GEMINI_DIAGNOSTIC_FORCE_REFRESH === '1' || tokenExpired;
    const sourceDescription = credentialSource.kind === 'base64'
        ? credentialSource.location
        : `${credentialSource.location}${credentialSource.exists ? '' : ' (file not found)'}`;

    if (!hasAccessToken && !hasRefreshToken) {
        throw new Error(
            `No Gemini OAuth credentials were loaded from ${sourceDescription}. ` +
            'Set GEMINI_DIAGNOSTIC_OAUTH_FILE, GEMINI_OAUTH_CREDS_FILE_PATH, or GEMINI_DIAGNOSTIC_OAUTH_BASE64.'
        );
    }

    if (hasAccessToken && !shouldForceRefresh) {
        return;
    }

    if (!hasRefreshToken) {
        throw new Error(
            `Gemini OAuth access token is missing or expired, and no refresh_token was loaded from ${sourceDescription}.`
        );
    }

    try {
        await refreshGeminiAccessToken(service, sourceDescription);
    } catch (error) {
        throw new Error(
            `Failed to refresh Gemini OAuth access token from ${sourceDescription}. ${summarizeValue(error?.message || error)}`.trim()
        );
    }

    if (!service.authClient.credentials.access_token) {
        throw new Error(
            `Gemini OAuth refresh completed but did not produce an access_token from ${sourceDescription}.`
        );
    }
}

function buildLoadCodeAssistBody() {
    return {
        cloudaicompanionProject: '',
        metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
            duetProject: '',
        },
    };
}

async function performRawGeminiRequest(service, fixedIp, method, body, model = null) {
    const url = new URL(`${service.codeAssistEndpoint}/${service.apiVersion}:${method}`);
    const payload = JSON.stringify(body);
    const accessToken = service.authClient.credentials.access_token;
    if (!accessToken) {
        throw new Error('Missing Gemini OAuth access token before request dispatch.');
    }

    return new Promise((resolve, reject) => {
        const request = https.request(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': `GeminiCLI/diagnostic/${model || 'unknown'} (${process.platform}; ${process.arch})`,
            },
            timeout: DIAGNOSTIC_TIMEOUT_MS,
            agent: service._getFixedIpAgent(url.hostname, fixedIp),
        }, (response) => {
            let rawBody = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                rawBody += chunk;
            });
            response.on('end', () => {
                let parsedBody = rawBody;
                try {
                    parsedBody = rawBody ? JSON.parse(rawBody) : null;
                } catch {
                    parsedBody = rawBody;
                }

                resolve({
                    status: response.statusCode ?? null,
                    data: parsedBody,
                    headers: response.headers,
                });
            });
        });

        request.on('timeout', () => {
            request.destroy(Object.assign(new Error(`Request timed out after ${DIAGNOSTIC_TIMEOUT_MS}ms`), {
                code: 'ETIMEDOUT',
            }));
        });
        request.on('error', reject);
        request.write(payload);
        request.end();
    });
}

async function executeUnaryProbe(service, fixedIp, method, body, model = null) {
    const startedAt = Date.now();
    try {
        const response = await performRawGeminiRequest(service, fixedIp, method, body, model);
        const durationMs = Date.now() - startedAt;

        if (response.status !== null && response.status >= 200 && response.status < 300) {
            return {
                ok: true,
                status: response.status ?? 200,
                durationMs,
                classification: 'success',
                message: summarizeValue(response.data),
                data: response.data,
            };
        }

        const classification = classifyGeminiFixedIpResponse(response);
        return {
            ok: false,
            status: response.status ?? null,
            durationMs,
            classification: classification.reason,
            message: summarizeValue(response.data),
            data: response.data,
        };
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        const classification = classifyGeminiFixedIpError(error);
        return {
            ok: false,
            status: null,
            durationMs,
            classification: classification.reason,
            errorCode: error.code || null,
            message: summarizeValue(error.message),
        };
    }
}

async function runIpProbe(fixedIp, oauthFilePath = '') {
    const configuredProjectId = (process.env.GEMINI_DIAGNOSTIC_PROJECT_ID || process.env.PROJECT_ID || '').trim();
    const service = createGeminiServiceForIp(fixedIp, configuredProjectId, oauthFilePath);

    await ensureAccessToken(service, oauthFilePath);

    const loadCodeAssist = await executeUnaryProbe(
        service,
        fixedIp,
        'loadCodeAssist',
        buildLoadCodeAssistBody()
    );

    const discoveredProjectId = configuredProjectId || extractProjectId(loadCodeAssist.data);
    let generateContent = null;

    if (discoveredProjectId) {
        service.projectId = discoveredProjectId;
        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: DIAGNOSTIC_PROMPT }],
            }],
        };
        const apiRequest = service._buildCodeAssistGenerateRequest(DIAGNOSTIC_MODEL, requestBody);
        generateContent = await executeUnaryProbe(
            service,
            fixedIp,
            'generateContent',
            apiRequest,
            DIAGNOSTIC_MODEL
        );
    }

    return {
        fixedIp,
        projectId: discoveredProjectId,
        loadCodeAssist,
        generateContent,
    };
}

async function runCredentialProbe(oauthFilePath, sampledIps) {
    const results = [];
    for (const fixedIp of sampledIps) {
        console.log(`[Gemini Diagnostic] Probing ${fixedIp} with ${oauthFilePath}...`);
        try {
            const probeResult = await runIpProbe(fixedIp, oauthFilePath);
            results.push(probeResult);
        } catch (error) {
            const bootstrapFailure = {
                ok: false,
                status: null,
                durationMs: 0,
                classification: 'credential-bootstrap-error',
                errorCode: error?.code || null,
                message: summarizeValue(error?.message || error),
            };
            results.push({
                fixedIp,
                projectId: '',
                loadCodeAssist: bootstrapFailure,
                generateContent: null,
            });
            break;
        }
    }

    return {
        oauthFilePath,
        results,
    };
}

function formatProbeSummary(results, probeKey) {
    return results.map((result) => {
        const probe = result[probeKey];
        if (!probe) {
            return `${result.fixedIp}: skipped`;
        }

        const status = probe.status === null || probe.status === undefined ? 'n/a' : String(probe.status);
        const errorCode = probe.errorCode ? ` code=${probe.errorCode}` : '';
        const message = probe.message ? ` msg="${probe.message}"` : '';
        return `${result.fixedIp}: status=${status} class=${probe.classification}${errorCode}${message}`;
    }).join(' | ');
}

describe('Gemini fixed IP live diagnostics', () => {
    liveTest(
        'samples 3 random fixed IPs and reports real upstream failures for the current Gemini account',
        async () => {
            const ipPool = getCandidateIpPool();
            const sampledIps = sampleRandomIps(ipPool, DIAGNOSTIC_IP_COUNT);
            const oauthFilePaths = await discoverOauthFilePaths();

            if (sampledIps.length === 0) {
                throw new Error(
                    'No fixed IPs are available for diagnostics. Set GEMINI_DIAGNOSTIC_FIXED_IPS or GEMINI_FIXED_IPS.'
                );
            }

            if (oauthFilePaths.length === 0) {
                throw new Error(
                    'No Gemini OAuth credential files were found. Set GEMINI_DIAGNOSTIC_OAUTH_FILE or GEMINI_DIAGNOSTIC_OAUTH_FILES.'
                );
            }

            console.log(`[Gemini Diagnostic] Sampled fixed IPs: ${sampledIps.join(', ')}`);
            console.log(`[Gemini Diagnostic] Model: ${DIAGNOSTIC_MODEL}`);
            console.log(`[Gemini Diagnostic] OAuth files: ${oauthFilePaths.join(', ')}`);

            const credentialRuns = [];
            for (const oauthFilePath of oauthFilePaths) {
                credentialRuns.push(await runCredentialProbe(oauthFilePath, sampledIps));
            }

            console.table(credentialRuns.flatMap((run) => run.results.map((result) => ({
                credFile: path.basename(run.oauthFilePath),
                ip: result.fixedIp,
                projectId: result.projectId || '<none>',
                loadStatus: result.loadCodeAssist.status ?? 'n/a',
                loadClass: result.loadCodeAssist.classification,
                loadMs: result.loadCodeAssist.durationMs,
                loadMessage: result.loadCodeAssist.message || '',
            }))));

            const generateRows = credentialRuns
                .flatMap((run) => run.results
                    .filter((result) => result.generateContent)
                    .map((result) => ({
                    credFile: path.basename(run.oauthFilePath),
                    ip: result.fixedIp,
                    generateStatus: result.generateContent.status ?? 'n/a',
                    generateClass: result.generateContent.classification,
                    generateMs: result.generateContent.durationMs,
                    generateMessage: result.generateContent.message || '',
                })));

            if (generateRows.length > 0) {
                console.table(generateRows);
            } else {
                console.warn(
                    '[Gemini Diagnostic] generateContent was skipped for all sampled IPs because no project ID was available.'
                );
            }

            const failedCredentialRuns = [];
            for (const run of credentialRuns) {
                const hasSuccessfulLoad = run.results.some((result) => result.loadCodeAssist.ok);
                if (!hasSuccessfulLoad) {
                    failedCredentialRuns.push(
                        `${path.basename(run.oauthFilePath)}: loadCodeAssist failed on all sampled IPs. ${formatProbeSummary(run.results, 'loadCodeAssist')}`
                    );
                    continue;
                }

                const attemptedGenerate = run.results.some((result) => result.generateContent !== null);
                if (!attemptedGenerate) {
                    continue;
                }

                const hasSuccessfulGenerate = run.results.some((result) => result.generateContent?.ok);
                if (!hasSuccessfulGenerate) {
                    failedCredentialRuns.push(
                        `${path.basename(run.oauthFilePath)}: generateContent failed on all sampled IPs. ${formatProbeSummary(run.results, 'generateContent')}`
                    );
                }
            }

            if (failedCredentialRuns.length > 0) {
                throw new Error(failedCredentialRuns.join(' || '));
            }

            expect(credentialRuns).toHaveLength(oauthFilePaths.length);
        },
        180000
    );
});
