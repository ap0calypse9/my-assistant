import { Hono } from 'hono'
import { serve } from 'inngest/hono'
import { inngest } from './inngest/client.js'
import { telegramReplyFunction } from './inngest/telegram-reply.js'
import telegram from './telegram.js'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Railway!')
})

app.get('/marco', (c) => {
  return c.text('polo')
})

app.route('/telegram', telegram)
app.on(
  ['GET', 'POST', 'PUT'],
  '/api/inngest',
  serve({ client: inngest, functions: [telegramReplyFunction] }),
)

export default app
