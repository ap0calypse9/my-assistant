import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inngest } from '../src/inngest/client.ts'
import { generateGeminiTestResponse } from '../src/inngest/gemini-check.ts'
import app from '../src/app.ts'

const configureEnv = (t, values) => {
  const keys = [
    'TEST_ROUTE_KEY',
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

  for (const key of keys) delete process.env[key]
  Object.assign(process.env, values)
}

const mockInngestSend = (t, ids = ['event_test']) => {
  const send = t.mock.method(inngest, 'send', async () => ({ ids }))
  return { send }
}

test('requires the test route key before enqueueing an event', async (t) => {
  configureEnv(t, { TEST_ROUTE_KEY: 'test-only-key' })
  const { send } = mockInngestSend(t)

  const missingKey = await app.request('/test/ai')
  const wrongKey = await app.request('/test/ai?key=wrong')
  delete process.env.TEST_ROUTE_KEY
  const missingConfiguredKey = await app.request('/test/ai?key=test-only-key')

  assert.equal(missingKey.status, 401)
  assert.deepEqual(await missingKey.json(), { error: 'Unauthorized' })
  assert.equal(wrongKey.status, 401)
  assert.equal(missingConfiguredKey.status, 401)
  assert.equal(send.mock.callCount(), 0)
})

test('enqueues a Gemini event with a capped prompt and returns its ID', async (t) => {
  configureEnv(t, { TEST_ROUTE_KEY: 'test-only-key' })
  const { send } = mockInngestSend(t)
  const longPrompt = 'x'.repeat(600)

  const response = await app.request(
    `/test/ai?key=test-only-key&prompt=${longPrompt}`,
  )

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { eventId: 'event_test' })
  assert.equal(send.mock.calls[0].arguments[0].name, 'test/gemini.requested')
  assert.equal(send.mock.calls[0].arguments[0].data.prompt.length, 500)
})

test('uses a default prompt when enqueueing a Gemini event', async (t) => {
  configureEnv(t, { TEST_ROUTE_KEY: 'test-only-key' })
  const { send } = mockInngestSend(t)

  const response = await app.request('/test/ai?key=test-only-key')

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { eventId: 'event_test' })
  assert.equal(
    send.mock.calls[0].arguments[0].data.prompt,
    'Give me one short greeting.',
  )
})

test('rejects an Inngest response without an event ID', async (t) => {
  configureEnv(t, { TEST_ROUTE_KEY: 'test-only-key' })
  mockInngestSend(t, [])

  const response = await app.request('/test/ai?key=test-only-key')

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), {
    error: 'Unable to queue the AI test task',
  })
})

test('logs Inngest enqueue failures and returns a clear error', async (t) => {
  configureEnv(t, { TEST_ROUTE_KEY: 'test-only-key' })
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => loggedErrors.push(args))
  const send = t.mock.method(inngest, 'send', async () => {
    throw new Error('Test Inngest failure')
  })

  const response = await app.request('/test/ai?key=test-only-key')

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), {
    error: 'Unable to queue the AI test task',
  })
  assert.equal(send.mock.callCount(), 1)
  assert.ok(
    loggedErrors.some(
      ([message, error]) =>
        message === 'Failed to enqueue Gemini test event' &&
        error.message === 'Test Inngest failure',
    ),
  )
})

test('logs Gemini failures and returns a friendly task result', async (t) => {
  configureEnv(t, {
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-api-key',
  })
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => loggedErrors.push(args))
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'generativelanguage.googleapis.com')
    assert.equal(url.searchParams.has('key'), false)
    assert.equal(
      new Headers(init.headers).get('x-goog-api-key'),
      'test-google-api-key',
    )
    return Response.json(
      {
        error: {
          code: 429,
          message: 'Test Gemini API failure',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
      { status: 429 },
    )
  })

  const result = await generateGeminiTestResponse('test prompt')

  assert.deepEqual(result, {
    ok: false,
    statusCode: 429,
    error: 'Gemini rate limit exceeded',
  })
  assert.ok(
    loggedErrors.some(
      ([message, details]) =>
        message === 'Gemini text generation failed' &&
        details.statusCode === 429 &&
        details.message === 'Test Gemini API failure',
    ),
  )
})

test('maps non-rate-limit Gemini failures to a server error', async (t) => {
  configureEnv(t, {
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-api-key',
  })
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: {
          code: 500,
          message: 'Test Gemini server failure',
          status: 'INTERNAL',
        },
      },
      { status: 500 },
    ),
  )

  const result = await generateGeminiTestResponse('test prompt')

  assert.deepEqual(result, {
    ok: false,
    statusCode: 502,
    error: 'Gemini text generation failed',
  })
})
