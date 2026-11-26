import { createGoogle } from '@ai-sdk/google'

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'

export const createGeminiModel = () => {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY

  if (!apiKey) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured')
  }

  const modelName = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const google = createGoogle({ apiKey })
  return google(modelName)
}
