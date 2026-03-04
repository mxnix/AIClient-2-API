import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';

describe('Gemini converter regressions', () => {
    test('reads official system_instruction and generationConfig for OpenAI requests', () => {
        const converter = new GeminiConverter();
        const request = converter.toOpenAIRequest({
            model: 'gemini-3.1-pro-preview',
            system_instruction: {
                parts: [{ text: 'Follow the house style.' }]
            },
            generationConfig: {
                maxOutputTokens: 77,
                temperature: 0.25,
                topP: 0.6
            },
            contents: [{
                role: 'user',
                parts: [{ text: 'Hello' }]
            }]
        });

        expect(request.max_tokens).toBe(77);
        expect(request.temperature).toBe(0.25);
        expect(request.top_p).toBe(0.6);
        expect(request.messages[0]).toEqual({
            role: 'system',
            content: 'Follow the house style.'
        });
    });

    test('reads official system_instruction for Claude, Responses, and Codex requests', () => {
        const converter = new GeminiConverter();
        const geminiRequest = {
            model: 'gemini-3.1-pro-preview',
            system_instruction: {
                parts: [{ text: 'Use compact answers.' }]
            },
            contents: [{
                role: 'user',
                parts: [{ text: 'Hello' }]
            }]
        };

        expect(converter.toClaudeRequest(geminiRequest).system).toBe('Use compact answers.');
        expect(converter.toOpenAIResponsesRequest(geminiRequest).instructions).toBe('Use compact answers.');
        expect(converter.toCodexRequest(geminiRequest).instructions).toBe('Use compact answers.');
    });

    test('uses a text placeholder for non-image inlineData in OpenAI chat requests', () => {
        const converter = new GeminiConverter();
        const request = converter.toOpenAIRequest({
            model: 'gemini-3.1-pro-preview',
            contents: [{
                role: 'user',
                parts: [{
                    inlineData: {
                        mimeType: 'application/pdf',
                        data: 'JVBERi0xLjQK'
                    }
                }]
            }]
        });

        expect(request.messages).toEqual([{
            role: 'user',
            content: '[Binary attachment omitted: application/pdf]'
        }]);
    });

    test('keeps Gemini candidates as separate OpenAI choices', () => {
        const converter = new GeminiConverter();
        const response = converter.toOpenAIResponse({
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [{ text: 'first' }]
                    },
                    finishReason: 'STOP'
                },
                {
                    content: {
                        role: 'model',
                        parts: [{ text: 'second' }]
                    },
                    finishReason: 'STOP'
                }
            ]
        }, 'gemini-3.1-pro-preview');

        expect(response.choices).toHaveLength(2);
        expect(response.choices[0].message.content).toBe('first');
        expect(response.choices[1].message.content).toBe('second');
    });

    test('does not inject fake visible content into reasoning-only final stream chunks', () => {
        const converter = new GeminiConverter();
        const chunk = converter.toOpenAIStreamChunk({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{ thought: true, text: 'Internal reasoning' }]
                },
                finishReason: 'STOP'
            }]
        }, 'gemini-3.1-pro-preview');

        expect(chunk.choices[0].delta).toEqual({
            reasoning_content: 'Internal reasoning'
        });
        expect(chunk.choices[0].finish_reason).toBe('stop');
    });
});
