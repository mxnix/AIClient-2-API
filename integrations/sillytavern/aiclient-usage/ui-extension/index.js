const MODULE_ID = 'aiclient_usage_panel';
const BRIDGE_BASE = '/api/plugins/aiclient-usage-bridge';
const DEFAULT_SETTINGS = {
    autoRefreshSec: 0,
    preferredProvider: 'gemini-cli-oauth',
};

let elements = null;
let autoRefreshTimer = null;
let saveSettingsDebounced = null;
let settings = null;

function getContextSafe() {
    if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
        throw new Error('SillyTavern context API not found');
    }
    return window.SillyTavern.getContext();
}

function ensureSettings() {
    const context = getContextSafe();
    saveSettingsDebounced = context.saveSettingsDebounced;
    context.extensionSettings[MODULE_ID] = {
        ...DEFAULT_SETTINGS,
        ...(context.extensionSettings[MODULE_ID] || {}),
    };
    settings = context.extensionSettings[MODULE_ID];
}

function $(id) {
    return document.getElementById(id);
}

function setStatus(message, kind = 'info') {
    if (!elements?.status) return;
    elements.status.className = `aicu-status ${kind}`;
    elements.status.textContent = message;
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toFixed(2);
}

function formatReset(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
}

async function apiGet(path) {
    const response = await fetch(`${BRIDGE_BASE}${path}`, {
        method: 'GET',
        headers: buildRequestHeaders(false),
        credentials: 'same-origin',
    });
    return parseBridgeResponse(response);
}

async function apiPost(path, body) {
    const response = await fetch(`${BRIDGE_BASE}${path}`, {
        method: 'POST',
        headers: buildRequestHeaders(true),
        credentials: 'same-origin',
        body: JSON.stringify(body),
    });
    return parseBridgeResponse(response);
}

function getCsrfFromCookie() {
    const cookie = typeof document !== 'undefined' ? document.cookie : '';
    if (!cookie) return '';

    const parts = cookie.split(';');
    for (const part of parts) {
        const [rawKey, ...rawValue] = part.trim().split('=');
        const key = String(rawKey || '').trim();
        if (!key) continue;

        if (key.toLowerCase() === 'x-csrf-token' || key.toLowerCase() === 'csrf-token' || key.toLowerCase() === 'xsrf-token') {
            return decodeURIComponent(rawValue.join('=') || '');
        }
    }

    return '';
}

function getCsrfTokenFallback() {
    if (typeof window !== 'undefined') {
        const byWindow = window.csrfToken || window.CSRF_TOKEN || window._csrf;
        if (typeof byWindow === 'string' && byWindow) {
            return byWindow;
        }
    }

    if (typeof document !== 'undefined') {
        const meta = document.querySelector('meta[name="csrf-token"], meta[name="x-csrf-token"], meta[name="_csrf"]');
        if (meta) {
            const value = meta.getAttribute('content');
            if (value) return value;
        }
    }

    if (typeof localStorage !== 'undefined') {
        const lsKeys = ['csrfToken', 'csrf-token', '_csrf', 'X-CSRF-Token'];
        for (const key of lsKeys) {
            const value = localStorage.getItem(key);
            if (value) return value;
        }
    }

    return getCsrfFromCookie();
}

function buildRequestHeaders(includeJsonContentType) {
    let headers = {};

    if (typeof window !== 'undefined' && typeof window.getRequestHeaders === 'function') {
        try {
            const fromSt = window.getRequestHeaders();
            if (fromSt && typeof fromSt === 'object') {
                headers = { ...fromSt };
            }
        } catch (_error) {
            // Ignore and fall back to manual headers
        }
    }

    if (includeJsonContentType && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
    }

    const hasCsrfHeader =
        headers['X-CSRF-Token'] ||
        headers['x-csrf-token'] ||
        headers['csrf-token'] ||
        headers['xsrf-token'] ||
        headers['X-XSRF-Token'] ||
        headers['x-xsrf-token'];

    if (!hasCsrfHeader) {
        const token = getCsrfTokenFallback();
        if (token) {
            headers['X-CSRF-Token'] = token;
            headers['x-csrf-token'] = token;
        }
    }

    return headers;
}

async function parseBridgeResponse(response) {
    const rawText = await response.text();
    let data = null;

    if (rawText) {
        try {
            data = JSON.parse(rawText);
        } catch (_error) {
            const compact = rawText.replace(/\s+/g, ' ').trim().slice(0, 180);
            throw new Error(`Bridge returned non-JSON response (${response.status}): ${compact || response.statusText}`);
        }
    } else {
        data = {};
    }

    if (!response.ok || data.success === false) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
}

function renderInstances(usageData) {
    const container = elements.instances;
    container.innerHTML = '';

    const instances = Array.isArray(usageData?.instances) ? usageData.instances : [];
    if (!instances.length) {
        const empty = document.createElement('div');
        empty.className = 'aicu-empty';
        empty.textContent = 'No instances returned';
        container.appendChild(empty);
        return;
    }

    for (const instance of instances) {
        const card = document.createElement('div');
        card.className = 'aicu-instance';

        const head = document.createElement('div');
        head.className = 'aicu-instance-head';

        const name = document.createElement('div');
        name.className = 'aicu-instance-name';
        name.textContent = instance.name || instance.uuid || 'unknown';

        const badge = document.createElement('div');
        badge.className = `aicu-instance-badge ${instance.success ? 'ok' : 'fail'}`;
        badge.textContent = instance.success ? 'OK' : 'ERROR';

        head.appendChild(name);
        head.appendChild(badge);
        card.appendChild(head);

        if (instance.error) {
            const err = document.createElement('div');
            err.className = 'aicu-empty';
            err.textContent = instance.error;
            card.appendChild(err);
            container.appendChild(card);
            continue;
        }

        const breakdown = instance.usage?.usageBreakdown || [];
        if (!breakdown.length) {
            const empty = document.createElement('div');
            empty.className = 'aicu-empty';
            empty.textContent = 'No breakdown data';
            card.appendChild(empty);
            container.appendChild(card);
            continue;
        }

        for (const item of breakdown) {
            const row = document.createElement('div');
            row.className = 'aicu-row';

            const nameEl = document.createElement('div');
            nameEl.className = 'aicu-row-name';
            nameEl.title = item.displayName || item.modelName || item.resourceType || 'model';
            nameEl.textContent = item.displayName || item.modelName || item.resourceType || 'model';

            const usageEl = document.createElement('div');
            usageEl.className = 'aicu-row-usage';
            usageEl.textContent = `${formatNumber(item.currentUsage)} / ${formatNumber(item.usageLimit)}`;

            const resetEl = document.createElement('div');
            resetEl.className = 'aicu-row-reset';
            resetEl.textContent = formatReset(item.resetTime || item.nextDateReset);

            row.appendChild(nameEl);
            row.appendChild(usageEl);
            row.appendChild(resetEl);
            card.appendChild(row);
        }

        container.appendChild(card);
    }
}

function renderSummary(data) {
    const usage = data?.usage || {};
    const instances = usage?.instances || [];
    const successCount = Number(usage?.successCount || 0);
    const totalCount = Number(usage?.totalCount || instances.length || 0);
    const source = usage?._meta?.source || 'unknown';
    const fetchedAt = usage?._meta?.fetchedAt || usage?.serverTime || null;

    const fetchedText = fetchedAt ? new Date(fetchedAt).toLocaleString() : '--';
    elements.summary.textContent = `Provider: ${data.provider} | Instances: ${successCount}/${totalCount} | Source: ${source} | Updated: ${fetchedText}`;
}

async function loadBridgeConfig() {
    const data = await apiGet('/config');
    const config = data.config || {};

    elements.baseUrl.value = config.baseUrl || '';
    elements.password.placeholder = config.hasPassword ? 'Saved on server plugin' : 'Set AIClient admin password';
    elements.cacheMs.value = String(config.cacheMs || 15000);
    elements.timeoutMs.value = String(config.timeoutMs || 15000);
    elements.provider.value = settings.preferredProvider || config.provider || DEFAULT_SETTINGS.preferredProvider;
}

async function loadProviders() {
    try {
        const data = await apiGet('/providers');
        const providers = Array.isArray(data.providers) ? data.providers : [];
        const current = elements.provider.value;

        elements.provider.innerHTML = '';
        for (const provider of providers) {
            const option = document.createElement('option');
            option.value = provider;
            option.textContent = provider;
            elements.provider.appendChild(option);
        }

        if (providers.includes(current)) {
            elements.provider.value = current;
        } else if (providers.length > 0) {
            elements.provider.value = providers[0];
        }
    } catch (error) {
        setStatus(`Provider list failed: ${error.message}`, 'error');
    }
}

async function loadUsage(refresh = false) {
    const provider = elements.provider.value || settings.preferredProvider || DEFAULT_SETTINGS.preferredProvider;
    setStatus('Loading usage...', 'info');
    try {
        const data = await apiGet(`/usage?provider=${encodeURIComponent(provider)}&refresh=${refresh ? 'true' : 'false'}`);
        renderSummary(data);
        renderInstances(data.usage);
        setStatus('Usage updated', 'success');
    } catch (error) {
        setStatus(`Usage failed: ${error.message}`, 'error');
    }
}

function restartAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }

    const seconds = Number.parseInt(String(settings.autoRefreshSec || 0), 10);
    if (Number.isFinite(seconds) && seconds > 0) {
        autoRefreshTimer = setInterval(() => {
            loadUsage(false).catch(() => {
                // status text is updated in loadUsage
            });
        }, seconds * 1000);
    }
}

async function saveConfig() {
    const payload = {
        baseUrl: elements.baseUrl.value.trim(),
        provider: elements.provider.value,
        cacheMs: Number.parseInt(elements.cacheMs.value, 10),
        timeoutMs: Number.parseInt(elements.timeoutMs.value, 10),
    };

    const password = elements.password.value;
    if (password) {
        payload.password = password;
    }

    settings.preferredProvider = payload.provider || DEFAULT_SETTINGS.preferredProvider;
    settings.autoRefreshSec = Number.parseInt(elements.autoRefreshSec.value, 10) || 0;
    if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    }
    restartAutoRefresh();

    setStatus('Saving plugin config...', 'info');

    const query = new URLSearchParams();
    if (payload.baseUrl) query.set('baseUrl', payload.baseUrl);
    if (payload.provider) query.set('provider', payload.provider);
    if (Number.isFinite(payload.cacheMs)) query.set('cacheMs', String(payload.cacheMs));
    if (Number.isFinite(payload.timeoutMs)) query.set('timeoutMs', String(payload.timeoutMs));
    if (typeof payload.password === 'string') query.set('password', payload.password);

    await apiGet(`/config/save?${query.toString()}`);
    elements.password.value = '';
    setStatus('Config saved', 'success');
}

function buildPanelHtml() {
    return `
<div id="aicu-panel">
  <div class="aicu-title">AIClient Usage Panel</div>
  <div class="aicu-grid">
    <label class="aicu-field">
      <span>AIClient URL</span>
      <input id="aicu-base-url" type="text" placeholder="http://127.0.0.1:3000" />
    </label>
    <label class="aicu-field">
      <span>AIClient Password</span>
      <input id="aicu-password" type="password" placeholder="admin123" />
    </label>
    <label class="aicu-field">
      <span>Provider</span>
      <select id="aicu-provider">
        <option value="gemini-cli-oauth">gemini-cli-oauth</option>
      </select>
    </label>
    <label class="aicu-field">
      <span>Auto refresh (seconds, 0=off)</span>
      <input id="aicu-auto-refresh" type="number" min="0" step="1" />
    </label>
    <label class="aicu-field">
      <span>Plugin cache ms</span>
      <input id="aicu-cache-ms" type="number" min="0" step="1000" />
    </label>
    <label class="aicu-field">
      <span>Timeout ms</span>
      <input id="aicu-timeout-ms" type="number" min="2000" step="1000" />
    </label>
  </div>
  <div class="aicu-actions">
    <button id="aicu-save" class="menu_button">Save Config</button>
    <button id="aicu-check" class="menu_button">Check Connection</button>
    <button id="aicu-refresh" class="menu_button">Refresh Usage</button>
  </div>
  <div id="aicu-status" class="aicu-status info">Not initialized</div>
  <div id="aicu-summary" class="aicu-summary">No data</div>
  <div id="aicu-instances"></div>
</div>
`;
}

function bindElements() {
    elements = {
        baseUrl: $('aicu-base-url'),
        password: $('aicu-password'),
        provider: $('aicu-provider'),
        autoRefreshSec: $('aicu-auto-refresh'),
        cacheMs: $('aicu-cache-ms'),
        timeoutMs: $('aicu-timeout-ms'),
        saveBtn: $('aicu-save'),
        checkBtn: $('aicu-check'),
        refreshBtn: $('aicu-refresh'),
        status: $('aicu-status'),
        summary: $('aicu-summary'),
        instances: $('aicu-instances'),
    };
}

async function initializePanel() {
    ensureSettings();

    const host =
        document.querySelector('#extensions_settings2') ||
        document.querySelector('#extensions_settings') ||
        document.querySelector('#extensionsMenu');

    if (!host) {
        return;
    }

    if (document.getElementById('aicu-panel')) {
        return;
    }

    host.insertAdjacentHTML('beforeend', buildPanelHtml());
    bindElements();

    elements.autoRefreshSec.value = String(settings.autoRefreshSec || 0);

    elements.saveBtn.addEventListener('click', async () => {
        try {
            await saveConfig();
            await loadProviders();
            await loadUsage(true);
        } catch (error) {
            setStatus(`Save failed: ${error.message}`, 'error');
        }
    });

    elements.checkBtn.addEventListener('click', async () => {
        setStatus('Checking bridge connection...', 'info');
        try {
            await apiGet('/ping');
            setStatus('Connection OK', 'success');
        } catch (error) {
            setStatus(`Connection failed: ${error.message}`, 'error');
        }
    });

    elements.refreshBtn.addEventListener('click', async () => {
        await loadUsage(true);
    });

    elements.provider.addEventListener('change', () => {
        settings.preferredProvider = elements.provider.value;
        if (typeof saveSettingsDebounced === 'function') {
            saveSettingsDebounced();
        }
    });

    elements.autoRefreshSec.addEventListener('change', () => {
        settings.autoRefreshSec = Number.parseInt(elements.autoRefreshSec.value, 10) || 0;
        if (typeof saveSettingsDebounced === 'function') {
            saveSettingsDebounced();
        }
        restartAutoRefresh();
    });

    try {
        await loadBridgeConfig();
        await loadProviders();
        restartAutoRefresh();
        await loadUsage(false);
    } catch (error) {
        setStatus(`Init failed: ${error.message}`, 'error');
    }
}

function bootstrap() {
    initializePanel().catch((error) => {
        console.error('[AIClient Usage Panel] bootstrap error:', error);
    });
}

if (window.jQuery) {
    window.jQuery(bootstrap);
} else {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
}
