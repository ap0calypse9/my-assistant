import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { inngest } from './inngest/client.js'

const telegram = new Hono()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET

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

  let update: unknown
  try {
    update = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  if (!isRecord(update)) {
    return c.json({ ok: false, error: 'Invalid Telegram update' }, 400)
  }

  const updateId = update.update_id
  if (
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0
  ) {
    return c.json({ ok: false, error: 'Invalid Telegram update' }, 400)
  }

  const message = isRecord(update.message) ? update.message : undefined
  const chat = message && isRecord(message.chat) ? message.chat : undefined
  const text = message?.text
  const chatId = chat?.id

  if (
    typeof text !== 'string' ||
    !text.trim() ||
    (typeof chatId !== 'number' && typeof chatId !== 'string')
  ) {
    return c.json({ ok: true })
  }

  try {
    await inngest.send({
      id: String(updateId),
      name: 'telegram/message.received',
      data: { updateId, chatId, text },
    })
  } catch (error) {
    console.error('Failed to enqueue Telegram update', error)
    return c.json({ ok: false, error: 'Failed to queue Telegram update' }, 502)
  }

  return c.json({ ok: true })
})

export default telegram
