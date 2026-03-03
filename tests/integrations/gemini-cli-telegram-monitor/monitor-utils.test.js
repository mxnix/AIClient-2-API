import {
    IP_STATUS,
    MANUAL_REFRESH_CALLBACK_DATA,
    OVERALL_STATUS,
    buildCaption,
    buildRefreshReplyMarkup,
    classifyGeminiProbeResult,
    computeOverallStatus,
    formatCooldownDuration,
    getManualRefreshCooldownMs,
    normalizeGeminiCheckModel,
} from '../../../integrations/gemini-cli-telegram-monitor/monitor-utils.js';

describe('gemini telegram monitor utils', () => {
    test('classifies Gemini 429 quota exhaustion as working', () => {
        const result = classifyGeminiProbeResult({
            status: 429,
            data: {
                error: {
                    message: '429 You have exhausted your capacity on this model.',
                },
            },
        });

        expect(result.status).toBe(IP_STATUS.WORKING);
    });

    test('classifies Gemini 429 no capacity as down', () => {
        const result = classifyGeminiProbeResult({
            status: 429,
            data: {
                error: {
                    message: '429 No capacity available for model gemini-2.5-flash on the server.',
                },
            },
        });

        expect(result.status).toBe(IP_STATUS.DOWN);
    });

    test('returns ok when at least seventy five percent of IPs are working', () => {
        const result = computeOverallStatus([
            { ip: '1.1.1.1', status: IP_STATUS.WORKING },
            { ip: '1.1.1.2', status: IP_STATUS.WORKING },
            { ip: '1.1.1.3', status: IP_STATUS.WORKING },
            { ip: '1.1.1.4', status: IP_STATUS.UNKNOWN },
        ]);

        expect(result.overallStatus).toBe(OVERALL_STATUS.OK);
    });

    test('returns down when most IPs are down', () => {
        const result = computeOverallStatus([
            { ip: '1.1.1.1', status: IP_STATUS.DOWN },
            { ip: '1.1.1.2', status: IP_STATUS.DOWN },
            { ip: '1.1.1.3', status: IP_STATUS.UNKNOWN },
        ]);

        expect(result.overallStatus).toBe(OVERALL_STATUS.DOWN);
    });

    test('builds a caption with the requested template', () => {
        const caption = buildCaption({
            overallStatus: OVERALL_STATUS.ISSUE,
            lastCheckedAt: '03.03.2026 23:10:00 МСК',
            ipResults: [
                { ip: '108.177.14.95', status: IP_STATUS.WORKING },
                { ip: '142.250.150.95', status: IP_STATUS.DOWN },
                { ip: '142.251.1.95', status: IP_STATUS.UNKNOWN },
            ],
        });

        expect(caption).toContain('текущий статус gemini-cli');
        expect(caption).toContain('03.03.2026 23:10:00 МСК');
        expect(caption).toContain('ip-адреса (1 работает, 1 не работает)');
        expect(caption).toContain('<blockquote expandable>');
        expect(caption).toContain('<code>108.177.14.95</code> - работает');
        expect(caption).toContain('<code>142.250.150.95</code> - <b>не работает</b>');
        expect(caption).toContain('<code>142.251.1.95</code> - неизвестно');
    });

    test('normalizes gemini alias model names', () => {
        expect(normalizeGeminiCheckModel('gemini-3.1-pro')).toBe('gemini-3.1-pro-preview');
        expect(normalizeGeminiCheckModel('models/gemini-3-pro')).toBe('gemini-3-pro-preview');
    });

    test('builds refresh reply markup for the channel post button', () => {
        expect(buildRefreshReplyMarkup()).toEqual({
            inline_keyboard: [[
                {
                    text: 'Обновить',
                    callback_data: MANUAL_REFRESH_CALLBACK_DATA,
                },
            ]],
        });
    });

    test('uses the longer remaining cooldown between global and per-user limits', () => {
        expect(getManualRefreshCooldownMs({
            nowMs: 1_000,
            lastCompletedAtMs: 900,
            lastUserRefreshAtMs: 950,
            globalCooldownMs: 500,
            userCooldownMs: 100,
        })).toBe(400);
    });

    test('formats cooldown durations for callback responses', () => {
        expect(formatCooldownDuration(45_000)).toBe('45 сек');
        expect(formatCooldownDuration(3 * 60 * 1000)).toBe('3 мин');
        expect(formatCooldownDuration(125_000)).toBe('2 мин 5 сек');
    });
});
