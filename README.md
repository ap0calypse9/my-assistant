```
npm install
npm run dev
```

```
open http://localhost:3000
```

## Telegram conversation history

Apply the schema migration using the direct Neon connection string:

```sh
npm run db:migrate:telegram-history
```

The script reads `DATABASE_URL_UNPOOLED` from `.env` and does not print the connection string. Configure `TELEGRAM_HISTORY_LIMIT` (default `10`) and `TELEGRAM_HISTORY_CHAR_BUDGET` (default `6000`) on the app host if you want to override the memory limits.

## Telegram web lookups

The Telegram assistant can search for current information and read public pages users link to. Add `FIRECRAWL_API_KEY` to the Railway service's environment variables and to your local, git-ignored `.env` file. The bot limits each reply to two web lookups and sends no more than 8,000 scraped characters to Gemini. If the key is missing or a lookup fails, it answers without web results and briefly notes that it could not verify the information.
