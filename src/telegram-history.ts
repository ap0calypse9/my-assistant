import { Pool } from 'pg'

export type ChatId = number | string
export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  role: ChatRole
  text: string
}

let pool: Pool | undefined

const getPool = () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured')
  }

  pool ??= new Pool({ connectionString, max: 5 })
  return pool
}

export const telegramHistory = {
  async loadLastMessages(chatId: ChatId, limit: number): Promise<ChatMessage[]> {
    const result = await getPool().query<ChatMessage>(
      `SELECT role, text
       FROM telegram_messages
       WHERE chat_id = $1
       ORDER BY created_at DESC, update_id DESC,
         CASE role WHEN 'assistant' THEN 1 ELSE 0 END DESC
       LIMIT $2`,
      [String(chatId), limit],
    )

    return result.rows.reverse()
  },

  async saveTurn(
    chatId: ChatId,
    updateId: number,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO telegram_messages (chat_id, update_id, role, text)
       VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)
       ON CONFLICT (chat_id, update_id, role) DO NOTHING`,
      [String(chatId), updateId, userText, assistantText],
    )
  },

  async clearChat(chatId: ChatId): Promise<void> {
    await getPool().query('DELETE FROM telegram_messages WHERE chat_id = $1', [
      String(chatId),
    ])
  },
}

export const trimHistoryToCharacterBudget = (
  messages: ChatMessage[],
  characterBudget: number,
): ChatMessage[] => {
  if (!Number.isSafeInteger(characterBudget) || characterBudget < 0) {
    throw new RangeError('History character budget must be a non-negative integer')
  }

  let firstKept = 0
  let totalCharacters = messages.reduce(
    (total, message) => total + message.text.length,
    0,
  )

  while (totalCharacters > characterBudget && firstKept < messages.length) {
    totalCharacters -= messages[firstKept].text.length
    firstKept += 1
  }

  return messages.slice(firstKept)
}
