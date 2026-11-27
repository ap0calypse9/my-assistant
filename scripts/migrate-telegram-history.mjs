import { readFile } from 'node:fs/promises'
import { Client } from 'pg'

const connectionString = process.env.DATABASE_URL_UNPOOLED
if (!connectionString) {
  console.error('DATABASE_URL_UNPOOLED is required to run this migration.')
  process.exitCode = 1
} else {
  const migration = await readFile(
    new URL('../migrations/001_telegram_messages.sql', import.meta.url),
    'utf8',
  )
  const client = new Client({ connectionString })
  let connected = false

  try {
    await client.connect()
    connected = true
    await client.query(migration)
    console.log('Telegram conversation history migration applied.')
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'unknown'
    console.error(`Telegram history migration failed (database error ${code}).`)
    process.exitCode = 1
  } finally {
    if (connected) {
      try {
        await client.end()
      } catch {
        console.error('Could not close the migration database connection.')
        process.exitCode = 1
      }
    }
  }
}
