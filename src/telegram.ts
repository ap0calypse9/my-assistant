import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'

const telegram = new Hono()

type TelegramUpdate = {
  message?: {
    chat: {
      id: number | string
    }
    text?: string
  }
}

const webhookSecretMatches = (received: string | undefined, expected: string) => {
  if (!received) return false

  const receivedBytes = Buffer.from(received)
  const expectedBytes = Buffer.from(expected)

  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  )
}

telegram.post('/webhook', async (c) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET

  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN is not configured')
    return c.json({ ok: false, error: 'Bot token is not configured' }, 500)
  }

  if (!webhookSecret) {
    console.error('TELEGRAM_WEBHOOK_SECRET is not configured')
    return c.json({ ok: false, error: 'Webhook secret is not configured' }, 500)
  }

  if (
    !webhookSecretMatches(
      c.req.header('X-Telegram-Bot-Api-Secret-Token'),
      webhookSecret,
    )
  ) {
    return c.json({ ok: false, error: 'Invalid webhook secret' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = await c.req.json<TelegramUpdate>()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  const text = update.message?.text
  const chatId = update.message?.chat.id

  if (text === undefined || chatId === undefined) {
    return c.json({ ok: true })
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    )

    if (!response.ok) {
      const responseText = await response.text()
      console.error(`Telegram sendMessage failed: ${response.status} ${responseText}`)
    }
  } catch (error) {
    console.error('Telegram sendMessage request failed', error)
  }

  return c.json({ ok: true })
})

export default telegram
