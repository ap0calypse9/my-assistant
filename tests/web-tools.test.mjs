import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SdkError } from 'firecrawl'
import {
  createWebTools,
  MAX_SCRAPED_CONTENT_CHARS,
  MAX_WEB_TOOL_CALLS,
} from '../src/web-tools.ts'

const makeState = () => ({ calls: 0, failed: false })

test('search returns at most three bounded result snippets', async () => {
  const calls = []
  const client = {
    search: async (...args) => {
      calls.push(args)
      return {
        web: Array.from({ length: 5 }, (_, index) => ({
          title: `Title ${index}`,
          url: `https://example.com/${index}`,
          description: 'x'.repeat(700),
        })),
      }
    },
    scrape: async () => {
      throw new Error('Unexpected scrape')
    },
  }
  const tools = createWebTools(client, makeState())

  const result = await tools.searchWeb.execute({ query: 'latest update' })

  assert.deepEqual(calls, [['latest update', { limit: 3 }]])
  assert.equal(result.results.length, 3)
  assert.equal(result.results[0].snippet.length, 500)
})

test('reading a page caps content and rejects non-public URLs before requesting', async () => {
  const calls = []
  const client = {
    search: async () => ({ web: [] }),
    scrape: async (...args) => {
      calls.push(args)
      return { markdown: 'x'.repeat(MAX_SCRAPED_CONTENT_CHARS + 100) }
    },
  }
  const state = makeState()
  const tools = createWebTools(client, state)
  const originalError = console.error
  console.error = () => {}

  let result
  let rejected
  try {
    result = await tools.readWebPage.execute({
      url: 'https://example.com/article',
    })
    rejected = await tools.readWebPage.execute({
      url: 'http://127.0.0.1/private',
    })
  } finally {
    console.error = originalError
  }

  assert.deepEqual(calls, [
    [
      'https://example.com/article',
      { formats: ['markdown'], onlyMainContent: true },
    ],
  ])
  assert.equal(result.content.length, MAX_SCRAPED_CONTENT_CHARS)
  assert.equal(state.failed, true)
  assert.deepEqual(rejected, {
    error:
      "Web access is unavailable. Answer using information already available and briefly say you could not verify it.",
  })
})

test('does not make more than the per-reply web lookup budget', async () => {
  let calls = 0
  const client = {
    search: async () => {
      calls += 1
      return { web: [] }
    },
    scrape: async () => {
      calls += 1
      return { markdown: 'Page content' }
    },
  }
  const tools = createWebTools(client, makeState())

  await tools.searchWeb.execute({ query: 'topic' })
  await tools.readWebPage.execute({ url: 'https://example.com' })
  const overBudget = await tools.searchWeb.execute({ query: 'another topic' })

  assert.equal(calls, MAX_WEB_TOOL_CALLS)
  assert.match(overBudget.error, /limit/)
})

test('logs Firecrawl SDK status, response message, and cause without headers', async (t) => {
  const state = makeState()
  const originalKey = process.env.FIRECRAWL_API_KEY
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-secret'
  t.after(() => {
    if (originalKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY
    } else {
      process.env.FIRECRAWL_API_KEY = originalKey
    }
  })

  const cause = Object.assign(new Error('HTTP request failed'), {
    name: 'AxiosError',
    config: {
      headers: {
        Authorization: 'Bearer test-firecrawl-secret',
        'X-Request-Id': 'private-header',
      },
    },
  })
  const sdkError = Object.assign(
    new SdkError(
      'Unexpected HTTP client error',
      402,
      'CREDITS_EXHAUSTED',
      { message: 'Firecrawl credits exhausted' },
    ),
    { cause },
  )
  const client = {
    search: async () => {
      throw sdkError
    },
    scrape: async () => ({ markdown: '' }),
  }
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => loggedErrors.push(args))

  const tools = createWebTools(client, state)
  const result = await tools.searchWeb.execute({ query: 'current news' })

  assert.equal(state.failed, true)
  assert.match(result.error, /Web access is unavailable/)
  assert.equal(loggedErrors.length, 1)
  assert.equal(loggedErrors[0][0], 'Web lookup failed')
  assert.equal(loggedErrors[0][1].statusCode, 402)
  assert.equal(loggedErrors[0][1].errorName, 'FirecrawlSdkError')
  assert.equal(
    loggedErrors[0][1].responseBodyMessage,
    'Firecrawl credits exhausted',
  )
  assert.deepEqual(loggedErrors[0][1].cause, {
    name: 'AxiosError',
    message: 'HTTP request failed',
  })
  const serializedLog = JSON.stringify(loggedErrors)
  assert.equal(serializedLog.includes('test-firecrawl-secret'), false)
  assert.equal(serializedLog.includes('Authorization'), false)
  assert.equal(serializedLog.includes('private-header'), false)
})

test('handles an SDK error response returned instead of thrown', async (t) => {
  const state = makeState()
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => loggedErrors.push(args))
  const client = {
    search: async () => ({
      success: false,
      status: 402,
      error: 'Firecrawl credits exhausted',
    }),
    scrape: async () => ({ markdown: '' }),
  }
  const tools = createWebTools(client, state)

  const result = await tools.searchWeb.execute({ query: 'current news' })

  assert.equal(state.failed, true)
  assert.match(result.error, /Web access is unavailable/)
  assert.equal(loggedErrors[0][1].statusCode, 402)
  assert.equal(loggedErrors[0][1].errorName, 'FirecrawlResponseError')
  assert.equal(
    loggedErrors[0][1].responseBodyMessage,
    'Firecrawl credits exhausted',
  )
})
