import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('reports Firecrawl failures without throwing from the tool', async () => {
  const state = makeState()
  const client = {
    search: async () => {
      throw new Error('credits exhausted')
    },
    scrape: async () => ({ markdown: '' }),
  }
  const originalError = console.error
  console.error = () => {}

  try {
    const tools = createWebTools(client, state)
    const result = await tools.searchWeb.execute({ query: 'current news' })

    assert.equal(state.failed, true)
    assert.match(result.error, /Web access is unavailable/)
  } finally {
    console.error = originalError
  }
})
