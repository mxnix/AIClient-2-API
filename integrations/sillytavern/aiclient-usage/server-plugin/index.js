const fs = require('fs/promises');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = Object.freeze({
    baseUrl: 'http://127.0.0.1:3000',
    password: '',
    provider: 'gemini-cli-oauth',
    cacheMs: 15000,
    timeoutMs: 15000,
});

const state = {
    config: { ...DEFAULT_CONFIG },
    token: null,
    tokenExpiryMs: 0,
    cachedUsage: null,
    cachedUsageAtMs: 0,
    cachedProvider: null,
};

async function readJsonBody(req, maxBytes = 128 * 1024) {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        return req.body;
    }

    if (typeof req.body === 'string' && req.body.trim()) {
        try {
            return JSON.parse(req.body);
        } catch (_error) {
            const error = new Error('Invalid JSON body');
            error.status = 400;
            throw error;
        }
    }

    if (req.readableEnded || req.complete || !req.readable) {
        return {};
    }

    const chunks = [];
    let total = 0;

    await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                const error = new Error('Request body too large');
                error.status = 413;
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', resolve);
        req.on('error', reject);
    });

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (_error) {
        const error = new Error('Invalid JSON body');
        error.status = 400;
        throw error;
    }
}

function normalizeBaseUrl(input) {
    if (typeof input !== 'string' || !input.trim()) {
        return DEFAULT_CONFIG.baseUrl;
    }

    const trimmed = input.trim().replace(/\/+$/, '');
    return trimmed;
}

function normalizePositiveInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function sanitizeConfigForClient(config) {
    return {
        baseUrl: config.baseUrl,
        provider: config.provider,
        cacheMs: config.cacheMs,
        timeoutMs: config.timeoutMs,
        hasPassword: Boolean(config.password),
    };
}

async function readConfig() {
    try {
        const raw = await fs.readFile(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        state.config = {
            baseUrl: normalizeBaseUrl(parsed.baseUrl),
            password: typeof parsed.password === 'string' ? parsed.password : '',
            provider: typeof parsed.provider === 'string' && parsed.provider ? parsed.provider : DEFAULT_CONFIG.provider,
            cacheMs: normalizePositiveInt(parsed.cacheMs, DEFAULT_CONFIG.cacheMs, 0, 10 * 60 * 1000),
            timeoutMs: normalizePositiveInt(parsed.timeoutMs, DEFAULT_CONFIG.timeoutMs, 2000, 60 * 1000),
        };
    } catch (_error) {
        state.config = { ...DEFAULT_CONFIG };
        await writeConfig(state.config);
    }
}

async function writeConfig(config) {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function updateConfig(patch) {
    const next = {
        ...state.config,
        ...patch,
    };

    next.baseUrl = normalizeBaseUrl(next.baseUrl);
    next.provider = typeof next.provider === 'string' && next.provider ? next.provider : DEFAULT_CONFIG.provider;
    next.cacheMs = normalizePositiveInt(next.cacheMs, DEFAULT_CONFIG.cacheMs, 0, 10 * 60 * 1000);
    next.timeoutMs = normalizePositiveInt(next.timeoutMs, DEFAULT_CONFIG.timeoutMs, 2000, 60 * 1000);
    next.password = typeof next.password === 'string' ? next.password : state.config.password;

    state.config = next;
    return next;
}

function parseExpiryMs(expiresIn) {
    if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
        return Date.now() + expiresIn * 1000;
    }
    if (typeof expiresIn === 'string') {
        const n = Number.parseInt(expiresIn, 10);
        if (Number.isFinite(n)) {
            return Date.now() + n * 1000;
        }
    }
    return Date.now() + 55 * 60 * 1000;
}

function hasValidToken() {
    return Boolean(state.token) && Date.now() < state.tokenExpiryMs - 5000;
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function parseResponse(response) {
    const text = await response.text();
    let payload = null;

    if (text) {
        try {
            payload = JSON.parse(text);
        } catch (_error) {
            payload = text;
        }
    }

    if (!response.ok) {
        const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const error = new Error(`Upstream ${response.status}: ${detail || response.statusText}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

async function loginIfNeeded(force = false) {
    if (!force && hasValidToken()) {
        return state.token;
    }

    const { baseUrl, password, timeoutMs } = state.config;

    if (!password) {
        const error = new Error('AIClient password is empty. Set it in plugin config.');
        error.status = 400;
        throw error;
    }

    const response = await fetchWithTimeout(
        `${baseUrl}/api/login`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ password }),
        },
        timeoutMs,
    );

    const data = await parseResponse(response);
    if (!data || typeof data.token !== 'string' || !data.token) {
        throw new Error('Login response does not contain token');
    }

    state.token = data.token;
    state.tokenExpiryMs = parseExpiryMs(data.expiresIn);
    return state.token;
}

async function fetchSupportedProviders() {
    const { baseUrl, timeoutMs } = state.config;
    const token = await loginIfNeeded(false);

    const response = await fetchWithTimeout(
        `${baseUrl}/api/usage/supported-providers`,
        {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            },
        },
        timeoutMs,
    );

    return parseResponse(response);
}

async function fetchUsage(provider, refresh) {
    const { baseUrl, timeoutMs, cacheMs } = state.config;
    const targetProvider = provider || state.config.provider;

    const canUseCache = !refresh && cacheMs > 0 && state.cachedUsage && state.cachedProvider === targetProvider;
    if (canUseCache && Date.now() - state.cachedUsageAtMs < cacheMs) {
        return {
            ...state.cachedUsage,
            _meta: {
                source: 'plugin-cache',
                fetchedAt: new Date(state.cachedUsageAtMs).toISOString(),
            },
        };
    }

    let token = await loginIfNeeded(false);
    let response = await fetchWithTimeout(
        `${baseUrl}/api/usage/${encodeURIComponent(targetProvider)}?refresh=${refresh ? 'true' : 'false'}`,
        {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            },
        },
        timeoutMs,
    );

    if (response.status === 401) {
        token = await loginIfNeeded(true);
        response = await fetchWithTimeout(
            `${baseUrl}/api/usage/${encodeURIComponent(targetProvider)}?refresh=${refresh ? 'true' : 'false'}`,
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
            timeoutMs,
        );
    }

    const data = await parseResponse(response);
    state.cachedUsage = data;
    state.cachedProvider = targetProvider;
    state.cachedUsageAtMs = Date.now();
    return {
        ...data,
        _meta: {
            source: 'upstream',
            fetchedAt: new Date(state.cachedUsageAtMs).toISOString(),
        },
    };
}

function normalizeIncomingConfig(payload) {
    const patch = {};

    if (Object.prototype.hasOwnProperty.call(payload, 'baseUrl')) {
        patch.baseUrl = payload.baseUrl;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'provider')) {
        patch.provider = payload.provider;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'cacheMs')) {
        patch.cacheMs = payload.cacheMs;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'timeoutMs')) {
        patch.timeoutMs = payload.timeoutMs;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'password')) {
        patch.password = payload.password;
        state.token = null;
        state.tokenExpiryMs = 0;
    }

    return patch;
}

function normalizeIncomingConfigFromQuery(query) {
    const payload = {};
    if (!query || typeof query !== 'object') {
        return payload;
    }

    if (Object.prototype.hasOwnProperty.call(query, 'baseUrl')) {
        payload.baseUrl = String(query.baseUrl || '');
    }
    if (Object.prototype.hasOwnProperty.call(query, 'provider')) {
        payload.provider = String(query.provider || '');
    }
    if (Object.prototype.hasOwnProperty.call(query, 'cacheMs')) {
        payload.cacheMs = String(query.cacheMs || '');
    }
    if (Object.prototype.hasOwnProperty.call(query, 'timeoutMs')) {
        payload.timeoutMs = String(query.timeoutMs || '');
    }
    if (Object.prototype.hasOwnProperty.call(query, 'password')) {
        payload.password = String(query.password || '');
    }

    return normalizeIncomingConfig(payload);
}

function sendError(res, error, fallbackStatus = 500) {
    const status = Number.isFinite(error?.status) ? error.status : fallbackStatus;
    res.status(status).json({
        success: false,
        error: error?.message || 'Unknown error',
    });
}

async function init(router) {
    await readConfig();

    router.get('/config', (_req, res) => {
        res.json({
            success: true,
            config: sanitizeConfigForClient(state.config),
        });
    });

    router.post('/config', async (req, res) => {
        try {
            const payload = await readJsonBody(req);
            const patch = normalizeIncomingConfig(payload);
            const next = updateConfig(patch);
            await writeConfig(next);
            res.json({
                success: true,
                config: sanitizeConfigForClient(next),
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/config/save', async (req, res) => {
        try {
            const patch = normalizeIncomingConfigFromQuery(req.query || {});
            const next = updateConfig(patch);
            await writeConfig(next);
            res.json({
                success: true,
                config: sanitizeConfigForClient(next),
                method: 'GET',
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/providers', async (_req, res) => {
        try {
            const providers = await fetchSupportedProviders();
            res.json({
                success: true,
                providers: Array.isArray(providers) ? providers : [],
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/usage', async (req, res) => {
        try {
            const provider = typeof req.query.provider === 'string' ? req.query.provider : state.config.provider;
            const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
            const usage = await fetchUsage(provider, refresh);
            res.json({
                success: true,
                provider,
                usage,
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get('/ping', async (_req, res) => {
        try {
            const { baseUrl, timeoutMs } = state.config;
            const response = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET' }, timeoutMs);
            const data = await parseResponse(response);
            res.json({
                success: true,
                health: data,
            });
        } catch (error) {
            sendError(res, error);
        }
    });
}

async function exit() {
    state.token = null;
    state.tokenExpiryMs = 0;
    state.cachedUsage = null;
    state.cachedUsageAtMs = 0;
    state.cachedProvider = null;
}

module.exports = {
    id: 'aiclient-usage-bridge',
    name: 'AIClient Usage Bridge',
    description: 'Expose AIClient usage query data to SillyTavern UI extensions.',
    init,
    exit,
    info: {
        id: 'aiclient-usage-bridge',
        name: 'AIClient Usage Bridge',
        description: 'Expose AIClient usage query data to SillyTavern UI extensions.',
    },
};
