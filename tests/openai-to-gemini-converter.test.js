import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';

describe('OpenAI to Gemini conversion', () => {
    test('does not inject maxOutputTokens when the OpenAI request omits max_tokens', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-flash',
            messages: [
                { role: 'user', content: 'Hello' },
            ],
        });

        expect(request.generationConfig).toBeDefined();
        expect(request.generationConfig.maxOutputTokens).toBeUndefined();
    });

    test('preserves explicit max_tokens as Gemini maxOutputTokens', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-flash',
            max_tokens: 512,
            messages: [
                { role: 'user', content: 'Hello' },
            ],
        });

        expect(request.generationConfig.maxOutputTokens).toBe(512);
    });

    test('does not inject default thinking for Gemini 3 preview when the client does not override reasoning', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3-flash-preview',
            messages: [
                { role: 'user', content: 'Hello' },
            ],
        });

        expect(request.generationConfig.topK).toBe(64);
        expect(request.generationConfig.thinkingConfig).toBeUndefined();
    });

    test('does not inject default thinking for gemini-3.1-pro-preview', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3.1-pro-preview',
            messages: [
                { role: 'user', content: 'Hello' },
            ],
        });

        expect(request.generationConfig.topK).toBe(64);
        expect(request.generationConfig.thinkingConfig).toBeUndefined();
    });

    test('does not inject Gemini 3 default thinking when reasoning_effort explicitly disables it', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3.1-pro-preview',
            reasoning_effort: 'none',
            messages: [
                { role: 'user', content: 'Hello' },
            ],
        });

        expect(request.generationConfig.topK).toBe(64);
        expect(request.generationConfig.thinkingConfig).toBeUndefined();
    });

    test('preserves interleaved system and developer messages after the first user turn', () => {
        const converter = new OpenAIConverter();
        const request = converter.toGeminiRequest({
            model: 'gemini-3.1-pro-preview',
            messages: [
                { role: 'system', content: 'Lead system instruction' },
                { role: 'user', content: 'First user turn' },
                { role: 'developer', content: 'Late developer note' },
                { role: 'assistant', content: 'Reply' },
            ],
        });

        expect(request.system_instruction).toEqual({
            parts: [{ text: 'Lead system instruction' }],
        });
        expect(request.contents).toEqual([
            {
                role: 'user',
                parts: [
                    { text: 'First user turn' },
                    { text: 'Late developer note' },
                ],
            },
            { role: 'model', parts: [{ text: 'Reply' }] },
        ]);
    });
});
