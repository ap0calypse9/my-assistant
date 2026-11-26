Run `npx hono --help` first, and use the CLI instead of a dev server.

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.agents/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-chat-agent`.
<!-- TRIGGER.DEV SKILLS END -->

## Railway environment variable sync

- Never sync the local `TRIGGER_SECRET_KEY` to Railway, including bulk `.env` uploads or environment-variable synchronization. It is a development key and must not overwrite Railway's production value.
- Preserve Railway's existing `TRIGGER_SECRET_KEY`; do not delete, unset, or replace it during syncs. If a sync operation cannot exclude this variable, do not run the bulk sync—sync the other variables individually.
