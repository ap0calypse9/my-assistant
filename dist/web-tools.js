import { isIP } from 'node:net';
import { jsonSchema, tool } from 'ai';
import { Firecrawl } from 'firecrawl';
export const MAX_WEB_TOOL_CALLS = 2;
export const MAX_SCRAPED_CONTENT_CHARS = 8000;
const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_SEARCH_RESULTS = 3;
const MAX_SEARCH_RESULT_CHARS = 500;
const FIRECRAWL_TIMEOUT_MS = 15_000;
const WEB_UNAVAILABLE_RESULT = "Web access is unavailable. Answer using information already available and briefly say you could not verify it.";
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const validateSearchInput = (value) => {
    if (!isRecord(value) || typeof value.query !== 'string') {
        return { success: false, error: new Error('Expected query') };
    }
    const query = value.query.trim();
    if (query.length === 0 || query.length > MAX_SEARCH_QUERY_CHARS) {
        return {
            success: false,
            error: new Error(`query must be between 1 and ${MAX_SEARCH_QUERY_CHARS} characters`),
        };
    }
    return { success: true, value: { query } };
};
const validatePageInput = (value) => {
    if (!isRecord(value) || typeof value.url !== 'string') {
        return { success: false, error: new Error('Expected url') };
    }
    const url = value.url.trim();
    if (url.length === 0 || url.length > 2048) {
        return {
            success: false,
            error: new Error('url must be between 1 and 2048 characters'),
        };
    }
    return { success: true, value: { url } };
};
const searchInputSchema = jsonSchema({
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
}, { validate: validateSearchInput });
const pageInputSchema = jsonSchema({
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
}, { validate: validatePageInput });
const validatePublicUrl = (value) => {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('Invalid web page URL');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        isIP(hostname) !== 0 ||
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.test')) {
        throw new Error('Only public HTTP or HTTPS pages can be read');
    }
    return url.href;
};
const excerpt = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const logWebFailure = (operation, error) => {
    console.error('Web lookup failed', {
        operation,
        message: error instanceof Error ? error.message.slice(0, 200) : 'Unknown error',
    });
};
export const createWebTools = (client, state) => {
    const run = async (operation, action) => {
        if (state.calls >= MAX_WEB_TOOL_CALLS) {
            return {
                error: 'The web lookup limit for this reply has been reached. Use results already received.',
            };
        }
        state.calls += 1;
        try {
            if (!client)
                throw new Error('FIRECRAWL_API_KEY is not configured');
            return await action(client);
        }
        catch (error) {
            state.failed = true;
            logWebFailure(operation, error);
            return { error: WEB_UNAVAILABLE_RESULT };
        }
    };
    return {
        searchWeb: tool({
            description: 'Search the public web for current information, fact-checking, or broad discovery. Use a short focused query. Returns up to three result titles, URLs, and brief snippets.',
            inputSchema: searchInputSchema,
            execute: ({ query }) => run('search', async (webClient) => {
                const result = await webClient.search(query, { limit: MAX_SEARCH_RESULTS });
                return {
                    results: (result.web ?? [])
                        .slice(0, MAX_SEARCH_RESULTS)
                        .map((item) => {
                        const record = isRecord(item) ? item : {};
                        const metadata = isRecord(record.metadata) ? record.metadata : {};
                        return {
                            title: excerpt(record.title ?? metadata.title, MAX_SEARCH_RESULT_CHARS),
                            url: excerpt(record.url ?? metadata.sourceURL, 2048),
                            snippet: excerpt(record.description ?? record.markdown, MAX_SEARCH_RESULT_CHARS),
                        };
                    }),
                };
            }),
        }),
        readWebPage: tool({
            description: 'Read and summarize the main content of a specific public web page, especially when the user provides a link. Returns at most 8,000 characters.',
            inputSchema: pageInputSchema,
            execute: ({ url }) => run('scrape', async (webClient) => {
                const pageUrl = validatePublicUrl(url);
                const result = await webClient.scrape(pageUrl, {
                    formats: ['markdown'],
                    onlyMainContent: true,
                });
                return {
                    url: pageUrl,
                    content: excerpt(result.markdown, MAX_SCRAPED_CONTENT_CHARS),
                };
            }),
        }),
    };
};
export const createWebClient = (apiKey) => {
    const key = apiKey?.trim();
    return key
        ? new Firecrawl({
            apiKey: key,
            maxRetries: 0,
            timeoutMs: FIRECRAWL_TIMEOUT_MS,
        })
        : undefined;
};
