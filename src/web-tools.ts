import { isIP } from 'node:net'
import { jsonSchema, tool } from 'ai'
import { Firecrawl } from 'firecrawl'

export const MAX_WEB_TOOL_CALLS = 2
export const MAX_SCRAPED_CONTENT_CHARS = 8000

const MAX_SEARCH_QUERY_CHARS = 500
const MAX_SEARCH_RESULTS = 3
const MAX_SEARCH_RESULT_CHARS = 500
const FIRECRAWL_TIMEOUT_MS = 15_000
const WEB_UNAVAILABLE_RESULT =
  "Web access is unavailable. Answer using information already available and briefly say you could not verify it."

export type WebToolState = {
  calls: number
  failed: boolean
}

type WebClient = Pick<Firecrawl, 'search' | 'scrape'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validateSearchInput = (value: unknown) => {
  if (!isRecord(value) || typeof value.query !== 'string') {
    return { success: false as const, error: new Error('Expected query') }
  }

  const query = value.query.trim()
  if (query.length === 0 || query.length > MAX_SEARCH_QUERY_CHARS) {
    return {
      success: false as const,
      error: new Error(
        `query must be between 1 and ${MAX_SEARCH_QUERY_CHARS} characters`,
      ),
    }
  }

  return { success: true as const, value: { query } }
}

const validatePageInput = (value: unknown) => {
  if (!isRecord(value) || typeof value.url !== 'string') {
    return { success: false as const, error: new Error('Expected url') }
  }

  const url = value.url.trim()
  if (url.length === 0 || url.length > 2048) {
    return {
      success: false as const,
      error: new Error('url must be between 1 and 2048 characters'),
    }
  }

  return { success: true as const, value: { url } }
}

const searchInputSchema = jsonSchema<{ query: string }>(
  {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_SEARCH_QUERY_CHARS,
        description: 'A focused web search query.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  { validate: validateSearchInput },
)

const pageInputSchema = jsonSchema<{ url: string }>(
  {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        minLength: 1,
        maxLength: 2048,
        description: 'The public HTTP or HTTPS page to read.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  { validate: validatePageInput },
)

const validatePublicUrl = (value: string) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid web page URL')
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.test')
  ) {
    throw new Error('Only public HTTP or HTTPS pages can be read')
  }

  return url.href
}

const excerpt = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : ''

const getResponseBodyMessage = (
  value: unknown,
  depth = 0,
): string | undefined => {
  if (depth > 4) return undefined
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined

  for (const key of ['message', 'error', 'detail', 'title']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    const nestedMessage = getResponseBodyMessage(candidate, depth + 1)
    if (nestedMessage) return nestedMessage
  }

  return getResponseBodyMessage(value.details, depth + 1)
}

const getErrorStatusCode = (error: unknown) => {
  if (!isRecord(error)) return undefined
  const cause = isRecord(error.cause) ? error.cause : undefined
  const candidates = [
    error,
    error.response,
    cause,
    cause?.response,
  ]

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    for (const key of ['status', 'statusCode']) {
      if (typeof candidate[key] === 'number') return candidate[key]
    }
  }

  return undefined
}

const redactSecret = (value: string) => {
  const key = process.env.FIRECRAWL_API_KEY?.trim()
  const truncated = excerpt(value, 500)
  return key ? truncated.replaceAll(key, '[REDACTED]') : truncated
}

const getCauseSummary = (error: unknown) => {
  if (!isRecord(error) || error.cause == null) return undefined
  const cause = error.cause

  if (cause instanceof Error) {
    return {
      name: redactSecret(cause.name),
      message: redactSecret(cause.message),
    }
  }
  if (isRecord(cause)) {
    return {
      name: typeof cause.name === 'string' ? redactSecret(cause.name) : undefined,
      message:
        typeof cause.message === 'string'
          ? redactSecret(cause.message)
          : undefined,
      code:
        typeof cause.code === 'string' ? redactSecret(cause.code) : undefined,
    }
  }
  return typeof cause === 'string' ? redactSecret(cause) : { type: typeof cause }
}

const throwForErrorResponse = (value: unknown) => {
  if (
    !isRecord(value) ||
    (value.success !== false && value.error == null)
  ) {
    return
  }

  const error = new Error(
    getResponseBodyMessage(value) ?? 'Firecrawl returned an error response',
  )
  error.name =
    typeof value.name === 'string' ? value.name : 'FirecrawlResponseError'
  Object.assign(error, {
    status:
      typeof value.status === 'number'
        ? value.status
        : typeof value.statusCode === 'number'
          ? value.statusCode
          : undefined,
    details: value,
    cause: value.cause,
  })
  throw error
}

const logWebFailure = (operation: string, error: unknown) => {
  const record = isRecord(error) ? error : undefined
  const cause = record && isRecord(record.cause) ? record.cause : undefined
  const response = record && isRecord(record.response) ? record.response : undefined
  const causeResponse =
    cause && isRecord(cause.response) ? cause.response : undefined
  const responseBodyMessage =
    getResponseBodyMessage(record?.details) ??
    getResponseBodyMessage(isRecord(response) ? response.data : undefined) ??
    getResponseBodyMessage(
      isRecord(causeResponse) ? causeResponse.data : undefined,
    ) ??
    getResponseBodyMessage(cause?.details) ??
    getResponseBodyMessage(record?.message)
  const causeSummary = getCauseSummary(error)

  console.error('Web lookup failed', {
    operation,
    statusCode: getErrorStatusCode(error) ?? null,
    errorName:
      typeof record?.name === 'string' ? redactSecret(record.name) : 'Unknown',
    message:
      typeof record?.message === 'string'
        ? redactSecret(record.message)
        : 'Unknown error',
    responseBodyMessage: responseBodyMessage
      ? redactSecret(responseBodyMessage)
      : null,
    ...(causeSummary === undefined ? {} : { cause: causeSummary }),
  })
}

export const createWebTools = (
  client: WebClient | undefined,
  state: WebToolState,
) => {
  const run = async <T>(
    operation: string,
    action: (webClient: WebClient) => Promise<T>,
  ): Promise<T | { error: string }> => {
    if (state.calls >= MAX_WEB_TOOL_CALLS) {
      return {
        error: 'The web lookup limit for this reply has been reached. Use results already received.',
      }
    }

    state.calls += 1
    try {
      if (!client) throw new Error('FIRECRAWL_API_KEY is not configured')
      return await action(client)
    } catch (error) {
      state.failed = true
      logWebFailure(operation, error)
      return { error: WEB_UNAVAILABLE_RESULT }
    }
  }

  return {
    searchWeb: tool({
      description:
        'Search the public web for current information, fact-checking, or broad discovery. Use a short focused query. Returns up to three result titles, URLs, and brief snippets.',
      inputSchema: searchInputSchema,
      execute: ({ query }) =>
        run('search', async (webClient) => {
          const result = await webClient.search(query, { limit: MAX_SEARCH_RESULTS })
          throwForErrorResponse(result)
          return {
            results: (result.web ?? [])
              .slice(0, MAX_SEARCH_RESULTS)
              .map((item) => {
                const record = isRecord(item) ? item : {}
                const metadata = isRecord(record.metadata) ? record.metadata : {}
                return {
                  title: excerpt(
                    record.title ?? metadata.title,
                    MAX_SEARCH_RESULT_CHARS,
                  ),
                  url: excerpt(record.url ?? metadata.sourceURL, 2048),
                  snippet: excerpt(
                    record.description ?? record.markdown,
                    MAX_SEARCH_RESULT_CHARS,
                  ),
                }
              }),
          }
        }),
    }),
    readWebPage: tool({
      description:
        'Read and summarize the main content of a specific public web page, especially when the user provides a link. Returns at most 8,000 characters.',
      inputSchema: pageInputSchema,
      execute: ({ url }) =>
        run('scrape', async (webClient) => {
          const pageUrl = validatePublicUrl(url)
          const result = await webClient.scrape(pageUrl, {
            formats: ['markdown'],
            onlyMainContent: true,
          })
          throwForErrorResponse(result)
          return {
            url: pageUrl,
            content: excerpt(result.markdown, MAX_SCRAPED_CONTENT_CHARS),
          }
        }),
    }),
  }
}

export const createWebClient = (apiKey: string | undefined) => {
  const key = apiKey?.trim()
  return key
    ? new Firecrawl({
        apiKey: key,
        maxRetries: 1,
        timeoutMs: FIRECRAWL_TIMEOUT_MS,
      })
    : undefined
}
