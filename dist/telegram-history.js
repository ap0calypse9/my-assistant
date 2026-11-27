import { Pool } from 'pg';
let pool;
const getPool = () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is not configured');
    }
    pool ??= new Pool({ connectionString, max: 5 });
    return pool;
};
export const telegramHistory = {
    async loadLastMessages(chatId, limit) {
        const result = await getPool().query(`SELECT role, text
       FROM telegram_messages
       WHERE chat_id = $1
       ORDER BY created_at DESC, update_id DESC,
         CASE role WHEN 'assistant' THEN 1 ELSE 0 END DESC
       LIMIT $2`, [String(chatId), limit]);
        return result.rows.reverse();
    },
    async saveTurn(chatId, updateId, userText, assistantText) {
        await getPool().query(`INSERT INTO telegram_messages (chat_id, update_id, role, text)
       VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)
       ON CONFLICT (chat_id, update_id, role) DO NOTHING`, [String(chatId), updateId, userText, assistantText]);
    },
    async clearChat(chatId) {
        await getPool().query('DELETE FROM telegram_messages WHERE chat_id = $1', [
            String(chatId),
        ]);
    },
};
export const trimHistoryToCharacterBudget = (messages, characterBudget) => {
    if (!Number.isSafeInteger(characterBudget) || characterBudget < 0) {
        throw new RangeError('History character budget must be a non-negative integer');
    }
    let firstKept = 0;
    let totalCharacters = messages.reduce((total, message) => total + message.text.length, 0);
    while (totalCharacters > characterBudget && firstKept < messages.length) {
        totalCharacters -= messages[firstKept].text.length;
        firstKept += 1;
    }
    return messages.slice(firstKept);
};
