import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { APICallError, generateText } from 'ai';
import { createGeminiModel } from './gemini.js';
const telegram = new Hono();
const RATE_LIMIT_REPLY = "I'm a bit busy right now. Please try again shortly.";
const GENERATION_ERROR_REPLY = "Sorry, I couldn't generate a reply right now. Please try again shortly.";
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const webhookSecretMatches = (received, expected) => {
    if (!received)
        return false;
    const receivedBytes = Buffer.from(received);
    const expectedBytes = Buffer.from(expected);
    return (receivedBytes.length === expectedBytes.length &&
        timingSafeEqual(receivedBytes, expectedBytes));
};
telegram.post('/webhook', async (c) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!botToken) {
        console.error('TELEGRAM_BOT_TOKEN is not configured');
        return c.json({ ok: false, error: 'Bot token is not configured' }, 500);
    }
    if (!webhookSecret) {
        console.error('TELEGRAM_WEBHOOK_SECRET is not configured');
        return c.json({ ok: false, error: 'Webhook secret is not configured' }, 500);
    }
    if (!webhookSecretMatches(c.req.header('X-Telegram-Bot-Api-Secret-Token'), webhookSecret)) {
        return c.json({ ok: false, error: 'Invalid webhook secret' }, 401);
    }
    let update;
    try {
        update = await c.req.json();
    }
    catch {
        return c.json({ ok: false, error: 'Invalid JSON' }, 400);
    }
    if (!isRecord(update)) {
        return c.json({ ok: false, error: 'Invalid Telegram update' }, 400);
    }
    const message = isRecord(update.message) ? update.message : undefined;
    const chat = message && isRecord(message.chat) ? message.chat : undefined;
    const text = message?.text;
    const chatId = chat?.id;
    if (typeof text !== 'string' ||
        !text.trim() ||
        (typeof chatId !== 'number' && typeof chatId !== 'string')) {
        return c.json({ ok: true });
    }
    const googleApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!googleApiKey) {
        console.error('GOOGLE_GENERATIVE_AI_API_KEY is not configured');
        return c.json({ ok: false, error: 'Google Gemini API key is not configured' }, 500);
    }
    let reply;
    try {
        const result = await generateText({
            model: createGeminiModel(),
            instructions: 'You are a helpful assistant replying in Telegram. Keep responses concise and in plain text.',
            prompt: text,
            maxOutputTokens: 256,
            maxRetries: 0,
        });
        reply = result.text.trim();
    }
    catch (error) {
        const statusCode = APICallError.isInstance(error)
            ? error.statusCode
            : undefined;
        console.error('Gemini text generation failed', {
            statusCode,
            message: error instanceof Error ? error.message : String(error),
        });
        reply = statusCode === 429 ? RATE_LIMIT_REPLY : GENERATION_ERROR_REPLY;
    }
    if (!reply) {
        console.error('Gemini text generation returned empty text');
        reply = GENERATION_ERROR_REPLY;
    }
    let response;
    try {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: reply }),
        });
    }
    catch (error) {
        console.error('Telegram sendMessage request failed', error instanceof Error ? error.message : String(error));
        return c.json({ ok: false, error: 'Telegram sendMessage request failed' }, 502);
    }
    if (!response.ok) {
        const responseText = await response.text();
        console.error(`Telegram sendMessage failed: ${response.status} ${responseText}`);
        return c.json({ ok: false, error: 'Telegram sendMessage failed' }, 502);
    }
    return c.json({ ok: true });
});
export default telegram;
