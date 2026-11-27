CREATE TABLE IF NOT EXISTS telegram_messages (
  chat_id BIGINT NOT NULL,
  update_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, update_id, role)
);

CREATE INDEX IF NOT EXISTS telegram_messages_recent_idx
  ON telegram_messages (chat_id, created_at DESC, update_id DESC);
