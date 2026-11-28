import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
import { generateReply } from '../src/inngest/telegram-reply.ts'

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
}

const modelResponse = (content, finishReason = 'stop') => ({
  content,
  finishReason: { unified: finishReason, raw: undefined },
  usage,
  warnings: [],
})

const toolCall = (toolName, input, toolCallId) =>
  modelResponse(
    [{ type: 'tool-call', toolName, input: JSON.stringify(input), toolCallId }],
    'tool-calls',
  )

test('recovers an answer from tool results when the final model step is empty', async (t) => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall('searchWeb', { query: 'latest release' }, 'search-1'),
      modelResponse([]),
      modelResponse([{ type: 'text', text: 'The latest release adds feature X.' }]),
    ],
  })
  const webClient = {
    search: async () => ({
      web: [
        {
          title: 'Release notes',
          url: 'https://example.com/releases',
          description: 'The latest release adds feature X.',
        },
      ],
    }),
    scrape: async () => ({ markdown: '' }),
  }
  const emptyTextLogs = []
  t.mock.method(console, 'error', (...args) => {
    if (args[0] === 'Gemini text generation returned empty text') {
      emptyTextLogs.push(args)
    }
  })

  const reply = await generateReply([], 'What changed recently?', model, webClient)

  assert.equal(reply, 'The latest release adds feature X.')
  assert.equal(model.doGenerateCalls.length, 3)
  assert.equal(model.doGenerateCalls[2].tools, undefined)
  assert.match(JSON.stringify(model.doGenerateCalls[2].prompt), /Release notes/)
  assert.deepEqual(emptyTextLogs, [
    [
      'Gemini text generation returned empty text',
      {
        phase: 'initial',
        finishReason: 'stop',
        stepsUsed: 2,
        hadToolCalls: true,
        hadToolResults: true,
      },
    ],
  ])
})

test('allows a final answer step after two web calls within the step limit', async () => {
  const searchCalls = []
  const scrapeCalls = []
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall('searchWeb', { query: 'latest release' }, 'search-1'),
      toolCall(
        'readWebPage',
        { url: 'https://example.com/releases' },
        'read-1',
      ),
      toolCall('searchWeb', { query: 'more details' }, 'search-2'),
      modelResponse([{ type: 'text', text: 'The release adds feature X.' }]),
    ],
  })
  const webClient = {
    search: async (...args) => {
      searchCalls.push(args)
      return {
        web: [
          {
            title: 'Release notes',
            url: 'https://example.com/releases',
            description: 'The release adds feature X.',
          },
        ],
      }
    },
    scrape: async (...args) => {
      scrapeCalls.push(args)
      return { markdown: 'The release adds feature X.' }
    },
  }

  const reply = await generateReply([], 'What changed recently?', model, webClient)

  assert.equal(reply, 'The release adds feature X.')
  assert.equal(model.doGenerateCalls.length, 4)
  assert.ok(model.doGenerateCalls[3].tools)
  assert.equal(searchCalls.length, 1)
  assert.equal(scrapeCalls.length, 1)
})

test('uses the friendly fallback if recovery generation is also empty', async (t) => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall('searchWeb', { query: 'latest release' }, 'search-1'),
      modelResponse([]),
      modelResponse([]),
    ],
  })
  const webClient = {
    search: async () => ({ web: [] }),
    scrape: async () => ({ markdown: '' }),
  }
  const emptyTextLogs = []
  t.mock.method(console, 'error', (...args) => {
    if (args[0] === 'Gemini text generation returned empty text') {
      emptyTextLogs.push(args)
    }
  })

  const reply = await generateReply([], 'What changed recently?', model, webClient)

  assert.equal(
    reply,
    "Sorry, I couldn't generate a reply right now. Please try again shortly.",
  )
  assert.equal(model.doGenerateCalls.length, 3)
  assert.equal(emptyTextLogs.length, 2)
  assert.equal(emptyTextLogs[1][1].phase, 'tool-result-recovery')
  assert.equal(emptyTextLogs[1][1].hadToolResults, true)
})
