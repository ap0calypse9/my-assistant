import { APICallError, generateText } from 'ai'
import { inngest } from './client.js'
import { createGeminiModel } from '../gemini.js'

export const generateGeminiTestResponse = async (prompt: string) => {
  try {
    const result = await generateText({
      model: createGeminiModel(),
      prompt,
      instructions:
        'You are a helpful assistant. Keep responses concise and in plain text.',
      maxOutputTokens: 96,
      maxRetries: 0,
    })
    const text = result.text.trim()

    if (!text) {
      console.error('Gemini text generation returned empty text')
      return {
        ok: false as const,
        statusCode: 502 as const,
        error: 'Gemini returned an empty response',
      }
    }

    return { ok: true as const, text }
  } catch (error) {
    const statusCode = APICallError.isInstance(error)
      ? error.statusCode
      : undefined
    console.error('Gemini text generation failed', {
      statusCode,
      message: error instanceof Error ? error.message : String(error),
    })

    return {
      ok: false as const,
      statusCode: statusCode === 429 ? (429 as const) : (502 as const),
      error:
        statusCode === 429
          ? 'Gemini rate limit exceeded'
          : 'Gemini text generation failed',
    }
  }
}

export const geminiTestFunction = inngest.createFunction(
  {
    id: 'test-gemini',
    triggers: { event: 'test/gemini.requested' },
  },
  async ({ event }) => {
    const prompt = event.data.prompt
    if (typeof prompt !== 'string') {
      throw new Error('Gemini test event prompt must be a string')
    }

    return generateGeminiTestResponse(prompt)
  },
)
