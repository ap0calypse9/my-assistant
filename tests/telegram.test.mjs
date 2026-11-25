import assert from 'node:assert/strict'
import { test } from 'node:test'
import app from '../src/app.ts'

const defaultModel = 'gemini-3.5-flash-lite'

const configureEnv = (t, model) => {
  const keys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_MODEL',
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
  })

  if (model === undefined) {
    delete process.env.GEMINI_MODEL
  } else {
    process.env.GEMINI_MODEL = model
  }
}

const mockFetch = (t, model, makeGeminiResponse) => {
  const sentMessages = []
  let geminiRequests = 0

  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))

    if (url.hostname === 'generativelanguage.googleapis.com') {
      geminiRequests += 1
      assert.equal(
        url.pathname,
        `/v1beta/models/${model}:generateContent`,
      )
      assert.equal(url.searchParams.has('key'), false)

      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-goog-api-key'), 'test-google-api-key')
      assert.equal(headers.get('Authorization'), null)

      const request = JSON.parse(String(init.body))
      assert.equal(
        request.contents[0].parts[0].text,
        'Original user message',
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

const postWebhook = () =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret',
    },
    body: JSON.stringify({
      message: { chat: { id: 123 }, text: 'Original user message' },
    }),
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

test('sends an AI-generated reply using the default model', async (t) => {
  configureEnv(t)
  const requests = mockFetch(t, defaultModel, generatedResponse)

  const response = await postWebhook()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(requests.geminiRequests, 1)
  assert.deepEqual(requests.sentMessages, [
    { chat_id: 123, text: 'Generated reply' },
  ])
})

test('uses GEMINI_MODEL when configured', async (t) => {
  const model = 'custom-model-override'
  configureEnv(t, model)
  const requests = mockFetch(t, model, generatedResponse)

  const response = await postWebhook()

  assert.equal(response.status, 200)
  assert.equal(requests.geminiRequests, 1)
})

test('reports a missing Google API key clearly', async (t) => {
  configureEnv(t)
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request')
  })

  const response = await postWebhook()

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Google Gemini API key is not configured',
  })
  assert.equal(fetch.mock.callCount(), 0)
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

    const response = await postWebhook()

    assert.equal(response.status, 200)
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
  })
}
