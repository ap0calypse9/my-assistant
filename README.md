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
