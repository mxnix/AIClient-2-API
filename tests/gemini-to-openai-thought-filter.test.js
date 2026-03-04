import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';

describe('Gemini -> OpenAI thought filtering', () => {
    test('keeps thought parts out of OpenAI message.content and exposes them as reasoning_content', () => {
        const converter = new GeminiConverter();

        const response = converter.toOpenAIResponse({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { thought: true, text: '**Framing a Response**' },
                        { thought: true, text: 'Thinking about the best greeting.' },
                        { text: 'Hello! How can I help you today?' }
                    ]
                },
                finishReason: 'STOP'
            }],
            usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 2,
                totalTokenCount: 3,
                thoughtsTokenCount: 1
            }
        }, 'gemini-3.1-pro-preview');

        expect(response.choices[0].message.content).toBe('Hello! How can I help you today?');
        expect(response.choices[0].message.reasoning_content).toBe(
            '**Framing a Response**\nThinking about the best greeting.'
        );
    });

    test('does not emit thought text as stream delta content', () => {
        const converter = new GeminiConverter();

        const chunk = converter.toOpenAIStreamChunk({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { thought: true, text: 'Internal reasoning' },
                        { text: 'Visible answer' }
                    ]
                }
            }]
        }, 'gemini-3.1-pro-preview');

        expect(chunk.choices[0].delta.content).toBe('Visible answer');
        expect(chunk.choices[0].delta.reasoning_content).toBe('Internal reasoning');
    });

    test('drops thought parts when converting Gemini conversation history to OpenAI messages', () => {
        const converter = new GeminiConverter();

        const request = converter.toOpenAIRequest({
            model: 'gemini-3.1-pro-preview',
            contents: [{
                role: 'model',
                parts: [
                    { thought: true, text: 'Hidden chain of thought' },
                    { text: 'Final visible answer' }
                ]
            }]
        });

        expect(request.messages).toEqual([{
            role: 'assistant',
            content: 'Final visible answer'
        }]);
    });

    test('keeps Gemini thought text out of OpenAI Responses output_text and exposes it as a reasoning item', () => {
        const converter = new GeminiConverter();

        const response = converter.toOpenAIResponsesResponse({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { thought: true, text: 'Internal reasoning' },
                        { text: 'apple' }
                    ]
                },
                finishReason: 'STOP'
            }],
            usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 2,
                totalTokenCount: 3,
                thoughtsTokenCount: 1
            }
        }, 'gemini-3.1-pro-preview');

        const messageItem = response.output.find(item => item.type === 'message');
        const reasoningItem = response.output.find(item => item.type === 'reasoning');

        expect(messageItem.content[0].text).toBe('apple');
        expect(reasoningItem.summary).toEqual([{
            type: 'summary_text',
            text: 'Internal reasoning'
        }]);
    });

    test('emits Gemini thought stream chunks as Responses reasoning deltas instead of output text deltas', () => {
        const converter = new GeminiConverter();

        const events = converter.toOpenAIResponsesStreamChunk({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { thought: true, text: 'Internal reasoning' },
                        { text: 'Visible answer' }
                    ]
                }
            }]
        }, 'gemini-3.1-pro-preview');

        const reasoningEvent = events.find(event => event.type === 'response.reasoning_summary_text.delta');
        const textEvent = events.find(event => event.type === 'response.output_text.delta');

        expect(reasoningEvent.delta).toBe('Internal reasoning');
        expect(textEvent.delta).toBe('Visible answer');
    });
});
