import { APICallError, generateText } from 'ai';
import { inngest } from './client.js';
import { createGeminiModel } from '../gemini.js';
import { telegramHistory, trimHistoryToCharacterBudget, } from '../telegram-history.js';
const RATE_LIMIT_REPLY = "I'm a bit busy right now. Please try again shortly.";
const GENERATION_ERROR_REPLY = "Sorry, I couldn't generate a reply right now. Please try again shortly.";
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isChatMessage = (value) => isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.text === 'string';
const isTelegramMessage = (value) => {
    if (!isRecord(value))
        return false;
    return (typeof value.updateId === 'number' &&
        Number.isSafeInteger(value.updateId) &&
        value.updateId >= 0 &&
        (typeof value.chatId === 'number' || typeof value.chatId === 'string') &&
        typeof value.text === 'string' &&
        value.text.trim().length > 0);
};
const generateReply = async (history, prompt) => {
    try {
        const result = await generateText({
            model: createGeminiModel(),
            instructions: 'You are a helpful assistant replying in Telegram. Keep responses concise and in plain text.',
            messages: [
                ...history.map(({ role, text }) => ({ role, content: text })),
                { role: 'user', content: prompt },
            ],
            maxOutputTokens: 256,
            maxRetries: 0,
        });
        const reply = result.text.trim();
        if (!reply) {
            console.error('Gemini text generation returned empty text');
            return GENERATION_ERROR_REPLY;
        }
        return reply;
    }
    catch (error) {
        const statusCode = APICallError.isInstance(error)
            ? error.statusCode
            : undefined;
        console.error('Gemini text generation failed', {
            statusCode,
            message: error instanceof Error ? error.message : String(error),
        });
        return statusCode === 429 ? RATE_LIMIT_REPLY : GENERATION_ERROR_REPLY;
    }
};
const getNonNegativeIntegerEnv = (name, defaultValue) => {
    const configured = process.env[name]?.trim();
    if (!configured)
        return defaultValue;
    const value = Number(configured);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
};
const isResetCommand = (text) => /^\/reset(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text.trim());
const requireTelegramBotToken = () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error('TELEGRAM_BOT_TOKEN is not configured');
        throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    return botToken;
};
const sendTelegramMessage = async (chatId, text) => {
    const botToken = requireTelegramBotToken();
    let response;
    try {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
    }
    catch (error) {
        console.error('Telegram sendMessage request failed', error instanceof Error ? error.message : String(error));
        throw error;
    }
    if (!response.ok) {
        const responseText = await response.text();
        console.error(`Telegram sendMessage failed: ${response.status} ${responseText}`);
        throw new Error(`Telegram sendMessage failed with status ${response.status}`);
    }
};
export const runTelegramReply = async (data, step) => {
    if (!isTelegramMessage(data)) {
        throw new Error('Telegram reply event has an invalid payload');
    }
    requireTelegramBotToken();
    if (isResetCommand(data.text)) {
        await step('reset-telegram-history', () => telegramHistory.clearChat(data.chatId));
        await step('send-telegram-reset-confirmation', () => sendTelegramMessage(data.chatId, 'Conversation history cleared.'));
        return;
    }
    const historyLimit = getNonNegativeIntegerEnv('TELEGRAM_HISTORY_LIMIT', 10);
    const historyCharacterBudget = getNonNegativeIntegerEnv('TELEGRAM_HISTORY_CHAR_BUDGET', 6000);
    const history = await step('load-telegram-history', () => telegramHistory.loadLastMessages(data.chatId, historyLimit));
    if (!Array.isArray(history) || !history.every(isChatMessage)) {
        throw new Error('Telegram history step returned an invalid result');
    }
    const boundedHistory = trimHistoryToCharacterBudget(history, historyCharacterBudget);
    const reply = await step('generate-gemini-reply', () => generateReply(boundedHistory, data.text));
    if (typeof reply !== 'string') {
        throw new Error('Gemini reply step returned an invalid result');
    }
    await step('send-telegram-message', () => sendTelegramMessage(data.chatId, reply));
    await step('save-telegram-conversation-turn', () => telegramHistory.saveTurn(data.chatId, data.updateId, data.text, reply));
};
export const telegramReplyFunction = inngest.createFunction({
    id: 'telegram-reply',
    concurrency: [{ key: 'event.data.chatId', limit: 1 }],
    triggers: { event: 'telegram/message.received' },
}, async ({ event, step }) => runTelegramReply(event.data, (id, handler) => step.run(id, handler)));
