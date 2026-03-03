import path from 'path';

export const DEFAULT_GEMINI_FIXED_IPS = Object.freeze([
    '108.177.14.95',
    '142.250.150.95',
    '142.251.1.95',
    '172.253.130.95',
    '173.194.73.95',
    '173.194.220.95',
    '173.194.221.95',
    '173.194.222.95',
    '209.85.233.95',
    '64.233.161.95',
    '64.233.162.95',
    '64.233.163.95',
    '64.233.164.95',
    '64.233.165.95',
    '74.125.131.95',
    '74.125.205.95',
]);

export const IP_STATUS = Object.freeze({
    WORKING: 'working',
    DOWN: 'down',
    UNKNOWN: 'unknown',
});

export const OVERALL_STATUS = Object.freeze({
    OK: 'ok',
    DOWN: 'down',
    ISSUE: 'issue',
});

export const IP_STATUS_LABELS = Object.freeze({
    [IP_STATUS.WORKING]: 'работает',
    [IP_STATUS.DOWN]: 'не работает',
    [IP_STATUS.UNKNOWN]: 'неизвестно',
});

export const OVERALL_STATUS_LABELS = Object.freeze({
    [OVERALL_STATUS.OK]: 'работает',
    [OVERALL_STATUS.DOWN]: 'не работает',
    [OVERALL_STATUS.ISSUE]: 'есть проблемы',
});

export const STATUS_IMAGE_FILENAMES = Object.freeze({
    [OVERALL_STATUS.OK]: 'noproblems.png',
    [OVERALL_STATUS.DOWN]: 'problems.png',
    [OVERALL_STATUS.ISSUE]: 'somethingwrong.png',
});

const GEMINI_MODEL_ALIASES = Object.freeze({
    'gemini-3.1-pro': 'gemini-3.1-pro-preview',
    'gemini-3-pro': 'gemini-3-pro-preview',
    'gemini-3-flash': 'gemini-3-flash-preview',
    'gemini-2.5-pro-preview': 'gemini-2.5-pro-preview-06-05',
    'gemini-2.5-flash-preview': 'gemini-2.5-flash-preview-09-2025',
});

export function normalizeIpList(rawValue) {
    if (rawValue === undefined || rawValue === null) {
        return [...DEFAULT_GEMINI_FIXED_IPS];
    }

    const entries = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue)
            .trim()
            .replace(/^\[|\]$/g, '')
            .split(/[\s,]+/);

    const uniqueIps = [];
    for (const entry of entries) {
        const candidate = String(entry || '').trim().replace(/^"|"$/g, '');
        if (!candidate || uniqueIps.includes(candidate)) {
            continue;
        }
        uniqueIps.push(candidate);
    }

    return uniqueIps;
}

export function normalizeGeminiCheckModel(rawModel) {
    if (typeof rawModel !== 'string') {
        return rawModel;
    }

    const trimmedModel = rawModel.trim();
    if (!trimmedModel) {
        return trimmedModel;
    }

    const cleanModel = trimmedModel.startsWith('models/')
        ? trimmedModel.substring('models/'.length)
        : trimmedModel;

    return GEMINI_MODEL_ALIASES[cleanModel] || cleanModel;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function summarizeIpStatuses(ipResults) {
    const counts = {
        working: 0,
        down: 0,
        unknown: 0,
    };

    for (const result of ipResults || []) {
        if (result?.status === IP_STATUS.WORKING) {
            counts.working += 1;
            continue;
        }

        if (result?.status === IP_STATUS.DOWN) {
            counts.down += 1;
            continue;
        }

        counts.unknown += 1;
    }

    return counts;
}

function formatIpStatusLabel(status) {
    const label = escapeHtml(IP_STATUS_LABELS[status] || IP_STATUS_LABELS[IP_STATUS.UNKNOWN]);
    if (status === IP_STATUS.DOWN) {
        return `<b>${label}</b>`;
    }

    return label;
}

export function extractErrorText(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    const nestedErrorMessage = value?.error?.message;
    if (typeof nestedErrorMessage === 'string') {
        return nestedErrorMessage;
    }

    const topLevelMessage = value?.message;
    if (typeof topLevelMessage === 'string') {
        return topLevelMessage;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function classifyGeminiProbeResult({ status, data, error }) {
    const errorText = extractErrorText(data ?? error);
    const normalizedErrorText = errorText.toLowerCase();
    const candidateCount = Number(
        data?.response?.candidates?.length ??
        data?.candidates?.length ??
        0
    );

    if (Number.isFinite(status) && status >= 200 && status < 300) {
        if (candidateCount > 0) {
            return {
                status: IP_STATUS.WORKING,
                detail: 'answered',
                errorText,
            };
        }

        return {
            status: IP_STATUS.UNKNOWN,
            detail: 'empty-success-response',
            errorText,
        };
    }

    if (status === 429) {
        if (normalizedErrorText.includes('you have exhausted your capacity')) {
            return {
                status: IP_STATUS.WORKING,
                detail: '429-quota-exhausted',
                errorText,
            };
        }

        if (normalizedErrorText.includes('no capacity available for model')) {
            return {
                status: IP_STATUS.DOWN,
                detail: '429-no-capacity',
                errorText,
            };
        }
    }

    return {
        status: IP_STATUS.UNKNOWN,
        detail: status ? `status-${status}` : 'transport-error',
        errorText,
    };
}

export function computeOverallStatus(ipResults) {
    const total = Array.isArray(ipResults) ? ipResults.length : 0;
    const counts = {
        working: 0,
        down: 0,
        unknown: 0,
    };

    for (const result of ipResults || []) {
        if (result?.status === IP_STATUS.WORKING) {
            counts.working += 1;
            continue;
        }

        if (result?.status === IP_STATUS.DOWN) {
            counts.down += 1;
            continue;
        }

        counts.unknown += 1;
    }

    const workingRatio = total > 0 ? counts.working / total : 0;
    let overallStatus = OVERALL_STATUS.ISSUE;

    if (total > 0 && workingRatio >= 0.75) {
        overallStatus = OVERALL_STATUS.OK;
    } else if (counts.down > total / 2) {
        overallStatus = OVERALL_STATUS.DOWN;
    } else if (counts.unknown > total / 2) {
        overallStatus = OVERALL_STATUS.ISSUE;
    }

    return {
        overallStatus,
        counts,
        total,
        workingRatio,
    };
}

export function formatMoscowTimestamp(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

    return `${formatter.format(date).replace(',', '')} МСК`;
}

export function buildCaption({ overallStatus, lastCheckedAt, ipResults }) {
    const counts = summarizeIpStatuses(ipResults);
    const lines = [
        `🔧 <b>текущий статус gemini-cli:</b> ${escapeHtml(OVERALL_STATUS_LABELS[overallStatus] || OVERALL_STATUS_LABELS[OVERALL_STATUS.ISSUE])}`,
        `📆 <b>последняя проверка:</b> ${escapeHtml(lastCheckedAt)}`,
        `📕 <b>ip-адреса (${counts.working} работает, ${counts.down} не работает):</b>`,
    ];

    const blockquoteLines = [];
    for (const result of ipResults || []) {
        blockquoteLines.push(`<code>${escapeHtml(result.ip)}</code> - ${formatIpStatusLabel(result.status)}`);
    }

    lines.push(`<blockquote expandable>${blockquoteLines.join('\n')}</blockquote>`);

    return lines.join('\n');
}

export function resolveStatusImagePath(assetsDir, overallStatus) {
    const imageName = STATUS_IMAGE_FILENAMES[overallStatus] || STATUS_IMAGE_FILENAMES[OVERALL_STATUS.ISSUE];
    return path.join(assetsDir, imageName);
}
