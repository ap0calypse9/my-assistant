import { APICallError, generateText } from 'ai';
import { task } from '@trigger.dev/sdk';
import { createGeminiModel } from '../gemini.js';
export const generateGeminiTestResponse = async (prompt) => {
    try {
        const result = await generateText({
            model: createGeminiModel(),
            prompt,
            instructions: 'You are a helpful assistant. Keep responses concise and in plain text.',
            maxOutputTokens: 96,
            maxRetries: 0,
        });
        const text = result.text.trim();
        if (!text) {
            console.error('Gemini text generation returned empty text');
            return {
                ok: false,
                statusCode: 502,
                error: 'Gemini returned an empty response',
            };
        }
        return { ok: true, text };
    }
    catch (error) {
        const statusCode = APICallError.isInstance(error)
            ? error.statusCode
            : undefined;
        console.error('Gemini text generation failed', {
            statusCode,
            message: error instanceof Error ? error.message : String(error),
        });
        return {
            ok: false,
            statusCode: statusCode === 429 ? 429 : 502,
            error: statusCode === 429
                ? 'Gemini rate limit exceeded'
                : 'Gemini text generation failed',
        };
    }
};
export const geminiTestTask = task({
    id: 'test-gemini',
    maxDuration: 120,
    retry: { maxAttempts: 1 },
    run: async ({ prompt }) => generateGeminiTestResponse(prompt),
});
