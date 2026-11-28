import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inngest } from '../src/inngest/client.ts'
import { runTelegramReply } from '../src/inngest/telegram-reply.ts'
import { telegramHistory } from '../src/telegram-history.ts'
import app from '../src/app.ts'

const defaultModel = 'gemini-3.5-flash-lite'

const configureEnv = (t, model) => {
  const keys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_MODEL',
    'TELEGRAM_HISTORY_LIMIT',
    'TELEGRAM_HISTORY_CHAR_BUDGET',
    'FIRECRAWL_API_KEY',
  ]
  const originalEnv = new Map(keys.map((key) => [key, process.env[key]]))

  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-api-key',
    FIRECRAWL_API_KEY: 'test-firecrawl-api-key',
  })
  delete process.env.TELEGRAM_HISTORY_LIMIT
  delete process.env.TELEGRAM_HISTORY_CHAR_BUDGET

  if (model === undefined) {
    delete process.env.GEMINI_MODEL
  } else {
    process.env.GEMINI_MODEL = model
  }
}

const mockInngestSend = (t) => {
  const events = []
  const send = t.mock.method(inngest, 'send', async (event) => {
    events.push(event)
    return { ids: [event.id] }
  })

  return { events, send }
}

const mockFetch = (t, model, makeGeminiResponse, history = []) => {
  const sentMessages = []
  let geminiRequests = 0

  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))

    if (url.hostname === 'generativelanguage.googleapis.com') {
      geminiRequests += 1
      assert.equal(url.pathname, `/v1beta/models/${model}:generateContent`)
      assert.equal(url.searchParams.has('key'), false)

      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-goog-api-key'), 'test-google-api-key')
      assert.equal(headers.get('Authorization'), null)

      const request = JSON.parse(String(init.body))
      assert.deepEqual(
        request.tools.flatMap(({ functionDeclarations }) =>
          functionDeclarations.map(({ name }) => name),
        ),
        ['searchWeb', 'readWebPage'],
      )
      assert.deepEqual(
        request.contents.map(({ role, parts }) => ({
          role,
          text: parts.map(({ text }) => text).join(''),
        })),
        [
          ...history.map(({ role, text }) => ({
            role: role === 'assistant' ? 'model' : 'user',
            text,
          })),
          { role: 'user', text: 'Original user message' },
        ],
      )

      return makeGeminiResponse()
    }

    assert.equal(
      url.href,
      'https://api.telegram.org/bottest-telegram-token/sendMessage',
    )
    sentMessages.push(JSON.parse(String(init.body)))
    return Response.json({ ok: true })
  })

  return {
    sentMessages,
    get geminiRequests() {
      return geminiRequests
    },
  }
}

const mockTelegramHistory = (t, messages = []) => {
  const calls = { loads: [], saves: [], clears: [] }
  t.mock.method(telegramHistory, 'loadLastMessages', async (...args) => {
    calls.loads.push(args)
    return messages
  })
  t.mock.method(telegramHistory, 'saveTurn', async (...args) => {
    calls.saves.push(args)
  })
  t.mock.method(telegramHistory, 'clearChat', async (...args) => {
    calls.clears.push(args)
  })
  return calls
}

const makeStep = () => {
  const calls = []
  const step = async (id, handler) => {
    calls.push(id)
    return handler()
  }
  return { calls, step }
}

const validUpdate = {
  update_id: 123456,
  message: { chat: { id: 123 }, text: 'Original user message' },
}

const postWebhook = (update = validUpdate, secret = 'test-webhook-secret') =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  })

const generatedResponse = () =>
  Response.json({
    candidates: [
      {
        content: { parts: [{ text: 'Generated reply' }] },
        finishReason: 'STOP',
      },
    ],
  })

test('enqueues a Telegram update using update_id and returns immediately', async (t) => {
  configureEnv(t)
  delete process.env.TELEGRAM_BOT_TOKEN
  const { events, send } = mockInngestSend(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('The webhook must not call external services')
  })

  const response = await postWebhook()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(send.mock.callCount(), 1)
  assert.deepEqual(events, [
    {
      id: '123456',
      name: 'telegram/message.received',
      data: {
        updateId: 123456,
        chatId: 123,
        text: 'Original user message',
      },
    },
  ])
  assert.equal(fetch.mock.callCount(), 0)
})

test('retries with the same update_id reuse the same Inngest event ID', async (t) => {
  configureEnv(t)
  const { events } = mockInngestSend(t)

  const firstResponse = await postWebhook()
  const retryResponse = await postWebhook()

  assert.equal(firstResponse.status, 200)
  assert.equal(retryResponse.status, 200)
  assert.equal(events[0].id, '123456')
  assert.equal(events[1].id, events[0].id)
})

test('rejects webhook requests with an invalid secret before enqueueing', async (t) => {
  configureEnv(t)
  const { send } = mockInngestSend(t)

  const response = await postWebhook(validUpdate, 'wrong-secret')

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Invalid webhook secret',
  })
  assert.equal(send.mock.callCount(), 0)
})

test('rejects updates without a valid update_id', async (t) => {
  configureEnv(t)
  const { send } = mockInngestSend(t)

  const response = await postWebhook({
    message: { chat: { id: 123 }, text: 'Original user message' },
  })

  assert.equal(response.status, 400)
  assert.equal(send.mock.callCount(), 0)
})

test('preserves empty-message handling without enqueueing an event', async (t) => {
  configureEnv(t)
  const { send } = mockInngestSend(t)

  const response = await postWebhook({
    update_id: 456,
    message: { chat: { id: 123 }, text: '  ' },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(send.mock.callCount(), 0)
})

test('returns a retryable error when Inngest cannot accept the event', async (t) => {
  configureEnv(t)
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => loggedErrors.push(args))
  const send = t.mock.method(inngest, 'send', async () => {
    throw new Error('Test Inngest failure')
  })

  const response = await postWebhook()

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Failed to queue Telegram update',
  })
  assert.equal(send.mock.callCount(), 1)
  assert.ok(
    loggedErrors.some(
      ([message, error]) =>
        message === 'Failed to enqueue Telegram update' &&
        error.message === 'Test Inngest failure',
    ),
  )
})

test('generates and sends a Gemini reply in durable steps', async (t) => {
  configureEnv(t)
  const history = mockTelegramHistory(t)
  const requests = mockFetch(t, defaultModel, generatedResponse)
  const { calls, step } = makeStep()

  await runTelegramReply(
    { updateId: 123456, chatId: 123, text: 'Original user message' },
    step,
  )

  assert.equal(requests.geminiRequests, 1)
  assert.deepEqual(requests.sentMessages, [
    { chat_id: 123, text: 'Generated reply' },
  ])
  assert.deepEqual(calls, [
    'load-telegram-history',
    'generate-gemini-reply',
    'send-telegram-message',
    'save-telegram-conversation-turn',
  ])
  assert.deepEqual(history.loads, [[123, 10]])
  assert.deepEqual(history.saves, [
    [123, 123456, 'Original user message', 'Generated reply'],
  ])
})

test('loads chronological history and trims oldest messages to the character budget', async (t) => {
  configureEnv(t)
  process.env.TELEGRAM_HISTORY_LIMIT = '5'
  process.env.TELEGRAM_HISTORY_CHAR_BUDGET = '12'
  const historyMessages = [
    { role: 'user', text: 'oldest' },
    { role: 'assistant', text: 'middle' },
    { role: 'user', text: 'latest' },
  ]
  const history = mockTelegramHistory(t, historyMessages)
  const requests = mockFetch(
    t,
    defaultModel,
    generatedResponse,
    historyMessages.slice(1),
  )
  const { step } = makeStep()

  await runTelegramReply(
    { updateId: 123456, chatId: 123, text: 'Original user message' },
    step,
  )

  assert.deepEqual(history.loads, [[123, 5]])
  assert.equal(requests.geminiRequests, 1)
})

test('does not call Gemini when the Telegram bot token is missing', async (t) => {
  configureEnv(t)
  delete process.env.TELEGRAM_BOT_TOKEN
  const history = mockTelegramHistory(t)
  t.mock.method(console, 'error', () => {})
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected request without a Telegram bot token')
  })
  const { calls, step } = makeStep()

  await assert.rejects(
    runTelegramReply(
      { updateId: 123456, chatId: 123, text: 'Original user message' },
      step,
    ),
    /TELEGRAM_BOT_TOKEN is not configured/,
  )

  assert.deepEqual(calls, [])
  assert.deepEqual(history.loads, [])
  assert.equal(fetch.mock.callCount(), 0)
})

test('uses GEMINI_MODEL when configured for the Inngest function', async (t) => {
  const model = 'custom-model-override'
  configureEnv(t, model)
  const requests = mockFetch(t, model, generatedResponse)
  mockTelegramHistory(t)
  const { step } = makeStep()

  await runTelegramReply(
    { updateId: 123456, chatId: 123, text: 'Original user message' },
    step,
  )

  assert.equal(requests.geminiRequests, 1)
})

test('sends a friendly fallback when the Google API key is missing', async (t) => {
  configureEnv(t)
  const history = mockTelegramHistory(t)
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  const loggedErrors = []
  const sentMessages = []
  t.mock.method(console, 'error', (...args) => loggedErrors.push(args))
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))
    assert.equal(
      url.href,
      'https://api.telegram.org/bottest-telegram-token/sendMessage',
    )
    sentMessages.push(JSON.parse(String(init.body)))
    return Response.json({ ok: true })
  })
  const { step } = makeStep()

  await runTelegramReply(
    { updateId: 123456, chatId: 123, text: 'Original user message' },
    step,
  )

  assert.deepEqual(sentMessages, [
    {
      chat_id: 123,
      text: "Sorry, I couldn't generate a reply right now. Please try again shortly.",
    },
  ])
  assert.ok(
    loggedErrors.some(
      ([message, details]) =>
        message === 'Gemini text generation failed' &&
        details.message === 'GOOGLE_GENERATIVE_AI_API_KEY is not configured',
    ),
  )
  assert.deepEqual(history.saves, [
    [
      123,
      123456,
      'Original user message',
      "Sorry, I couldn't generate a reply right now. Please try again shortly.",
    ],
  ])
})

for (const [statusCode, status, expectedReply] of [
  [429, 'RESOURCE_EXHAUSTED', "I'm a bit busy right now. Please try again shortly."],
  [
    500,
    'INTERNAL',
    "Sorry, I couldn't generate a reply right now. Please try again shortly.",
  ],
]) {
  test(`sends a friendly fallback when Gemini returns HTTP ${statusCode}`, async (t) => {
    configureEnv(t)
    const history = mockTelegramHistory(t)
    const loggedErrors = []
    t.mock.method(console, 'error', (...args) => loggedErrors.push(args))
    const requests = mockFetch(t, defaultModel, () =>
      Response.json(
        {
          error: {
            code: statusCode,
            message: 'Test Gemini API failure',
            status,
          },
        },
        { status: statusCode },
      ),
    )
    const { step } = makeStep()

    await runTelegramReply(
      { updateId: 123456, chatId: 123, text: 'Original user message' },
      step,
    )

    assert.equal(requests.geminiRequests, 1)
    assert.deepEqual(requests.sentMessages, [
      { chat_id: 123, text: expectedReply },
    ])
    assert.ok(
      loggedErrors.some(
        ([message, details]) =>
          message === 'Gemini text generation failed' &&
          details.statusCode === statusCode &&
          details.message === 'Test Gemini API failure',
      ),
    )
    assert.equal(history.saves.length, 1)
  })
}

test('clears only that chat history for /reset and confirms in Telegram', async (t) => {
  configureEnv(t)
  const history = mockTelegramHistory(t)
  const sentMessages = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(
      String(input),
      'https://api.telegram.org/bottest-telegram-token/sendMessage',
    )
    sentMessages.push(JSON.parse(String(init.body)))
    return Response.json({ ok: true })
  })
  const { calls, step } = makeStep()

  await runTelegramReply(
    { updateId: 123456, chatId: 123, text: '/reset' },
    step,
  )

  assert.deepEqual(history.clears, [[123]])
  assert.deepEqual(history.loads, [])
  assert.deepEqual(history.saves, [])
  assert.deepEqual(sentMessages, [
    { chat_id: 123, text: 'Conversation history cleared.' },
  ])
  assert.deepEqual(calls, [
    'reset-telegram-history',
    'send-telegram-reset-confirmation',
  ])
})

test('does not save a turn when Telegram fails to send the generated reply', async (t) => {
  configureEnv(t)
  const history = mockTelegramHistory(t)
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'generativelanguage.googleapis.com') {
      return generatedResponse()
    }
    return Response.json(
      { ok: false, description: 'Test Telegram failure' },
      { status: 500 },
    )
  })
  const { calls, step } = makeStep()

  await assert.rejects(
    runTelegramReply(
      { updateId: 123456, chatId: 123, text: 'Original user message' },
      step,
    ),
    /Telegram sendMessage failed with status 500/,
  )

  assert.deepEqual(history.saves, [])
  assert.deepEqual(calls, [
    'load-telegram-history',
    'generate-gemini-reply',
    'send-telegram-message',
  ])
})
