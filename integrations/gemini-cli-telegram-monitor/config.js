import path from 'path';
import { promises as fs } from 'fs';
import {
    DEFAULT_GEMINI_FIXED_IPS,
    normalizeGeminiCheckModel,
    normalizeIpList,
} from './monitor-utils.js';

function readEnv(name) {
    const value = process.env[name];
    if (value === undefined || value === null) {
        return null;
    }

    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
}

function readNumberEnv(name, fallbackValue, minimum = null) {
    const rawValue = readEnv(name);
    if (rawValue === null) {
        return fallbackValue;
    }

    const parsedValue = Number(rawValue);
    if (!Number.isFinite(parsedValue)) {
        throw new Error(`Environment variable ${name} must be a number.`);
    }

    if (minimum !== null && parsedValue < minimum) {
        throw new Error(`Environment variable ${name} must be >= ${minimum}.`);
    }

    return parsedValue;
}

function readMessageIdEnv(name) {
    const rawValue = readEnv(name);
    if (rawValue === null) {
        return null;
    }

    const parsedValue = Number(rawValue);
    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
        throw new Error(`Environment variable ${name} must be a positive integer.`);
    }

    return parsedValue;
}

async function loadJsonIfExists(filePath) {
    try {
        const rawContent = await fs.readFile(filePath, 'utf8');
        return JSON.parse(rawContent);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function isWindowsAbsolutePath(rawPath) {
    return /^[a-zA-Z]:[\\/]/.test(String(rawPath || '')) ||
        String(rawPath || '').startsWith('\\\\');
}

async function resolveRelativePath(rawPath, baseDir) {
    if (!rawPath) {
        return null;
    }

    const normalizedPath = String(rawPath).trim().replace(/\\/g, '/');
    if (!normalizedPath) {
        return null;
    }

    if (path.isAbsolute(normalizedPath) || isWindowsAbsolutePath(normalizedPath)) {
        return normalizedPath;
    }

    const normalizedBaseDir = baseDir.replace(/\\/g, '/');
    const cleanedPath = normalizedPath.replace(/^\.\//, '');
    const candidatePaths = new Set([
        path.resolve(normalizedBaseDir, normalizedPath),
        path.resolve(normalizedBaseDir, cleanedPath),
    ]);

    if (cleanedPath.startsWith('configs/')) {
        candidatePaths.add(path.resolve(normalizedBaseDir, '..', cleanedPath));
    }

    for (const candidatePath of candidatePaths) {
        try {
            await fs.access(candidatePath);
            return candidatePath;
        } catch {
            // Try next candidate
        }
    }

    return [...candidatePaths][0];
}

function pickGeminiProviderNode(providerPools) {
    const providerEntries = providerPools?.['gemini-cli-oauth'];
    if (!Array.isArray(providerEntries) || providerEntries.length === 0) {
        return null;
    }

    return providerEntries.find((entry) => entry?.isDisabled !== true) || providerEntries[0] || null;
}

function ensureRequiredValue(value, name) {
    if (value === undefined || value === null || value === '') {
        throw new Error(`Missing required configuration value: ${name}`);
    }
}

export async function loadMonitorConfig() {
    const configJsonPath = readEnv('CONFIG_JSON_PATH') || '/configs/config.json';
    const providerPoolsPath = readEnv('PROVIDER_POOLS_FILE_PATH') || '/configs/provider_pools.json';

    const [configJson, providerPools] = await Promise.all([
        loadJsonIfExists(configJsonPath),
        loadJsonIfExists(providerPoolsPath),
    ]);

    const providerPoolsDir = path.dirname(providerPoolsPath);
    const geminiProviderNode = pickGeminiProviderNode(providerPools);

    const projectId = readEnv('PROJECT_ID') || geminiProviderNode?.PROJECT_ID || null;
    const oauthCredsBase64 = readEnv('GEMINI_OAUTH_CREDS_BASE64');
    const oauthCredsFilePath = readEnv('GEMINI_OAUTH_CREDS_FILE_PATH') ||
        await resolveRelativePath(geminiProviderNode?.GEMINI_OAUTH_CREDS_FILE_PATH, providerPoolsDir);

    const geminiBaseUrl = readEnv('GEMINI_BASE_URL') ||
        configJson?.GEMINI_BASE_URL ||
        'https://cloudcode-pa.googleapis.com';

    const fixedIps = normalizeIpList(
        readEnv('GEMINI_FIXED_IPS') ??
        configJson?.GEMINI_FIXED_IPS ??
        DEFAULT_GEMINI_FIXED_IPS
    );

    const config = {
        checkIntervalMs: readNumberEnv('MONITOR_INTERVAL_MS', 10 * 60 * 1000, 60 * 1000),
        probeTimeoutMs: readNumberEnv('PROBE_TIMEOUT_MS', 45 * 1000, 5 * 1000),
        probeConcurrency: readNumberEnv('PROBE_CONCURRENCY', 4, 1),
        gemini: {
            apiVersion: 'v1internal',
            baseUrl: geminiBaseUrl,
            oauthClientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
            oauthClientSecret: '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',
            projectId,
            checkModel: normalizeGeminiCheckModel(
                readEnv('GEMINI_CHECK_MODEL') ||
                geminiProviderNode?.checkModelName ||
                'gemini-2.5-flash'
            ),
            oauthCredsBase64,
            oauthCredsFilePath,
            fixedIps,
        },
        telegram: {
            botToken: readEnv('TELEGRAM_BOT_TOKEN'),
            chatId: readEnv('TELEGRAM_CHAT_ID'),
            messageId: readMessageIdEnv('TELEGRAM_MESSAGE_ID'),
        },
        assetsDir: readEnv('MONITOR_ASSETS_DIR') || '/assets',
        stateFilePath: readEnv('MONITOR_STATE_FILE') || '/data/state.json',
        auditLogFilePath: readEnv('MONITOR_AUDIT_LOG_FILE') || '/data/ip-status.log',
        sourceFiles: {
            configJsonPath,
            providerPoolsPath,
        },
    };

    ensureRequiredValue(config.telegram.botToken, 'TELEGRAM_BOT_TOKEN');
    ensureRequiredValue(config.telegram.chatId, 'TELEGRAM_CHAT_ID');

    if (!config.gemini.oauthCredsBase64 && !config.gemini.oauthCredsFilePath) {
        throw new Error(
            'Gemini OAuth credentials were not found. Set GEMINI_OAUTH_CREDS_BASE64 or GEMINI_OAUTH_CREDS_FILE_PATH, or expose them through provider_pools.json.'
        );
    }

    if (!Array.isArray(config.gemini.fixedIps) || config.gemini.fixedIps.length === 0) {
        throw new Error('No Gemini fixed IPs were configured.');
    }

    return config;
}
