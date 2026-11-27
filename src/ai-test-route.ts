import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { inngest } from './inngest/client.js'

const DEFAULT_PROMPT = 'Give me one short greeting.'
const MAX_PROMPT_LENGTH = 500

const matchesKey = (received: string | undefined, expected: string | undefined) => {
  if (!received || !expected) return false

  const receivedBytes = Buffer.from(received)
  const expectedBytes = Buffer.from(expected)

  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  )
}

const testAi = new Hono()

// TEMP: Remove this route after validating Inngest and Gemini.
testAi.get('/ai', async (c) => {
  if (!matchesKey(c.req.query('key'), process.env.TEST_ROUTE_KEY)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const prompt = (c.req.query('prompt')?.trim() || DEFAULT_PROMPT).slice(
    0,
    MAX_PROMPT_LENGTH,
  )

  try {
    const { ids } = await inngest.send({
      name: 'test/gemini.requested',
      data: { prompt },
    })
    const [eventId] = ids

    if (!eventId) {
      console.error('Inngest accepted no Gemini test event IDs')
      return c.json({ error: 'Unable to queue the AI test task' }, 502)
    }

    return c.json({ eventId }, 202)
  } catch (error) {
    console.error('Failed to enqueue Gemini test event', error)
    return c.json({ error: 'Unable to queue the AI test task' }, 502)
  }
})

export default testAi
