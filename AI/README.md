# AI Subsystem (LoveChatty)

This directory is the source of truth for AI behavior and backend AI runtime.

## Structure

- `AI/Instructions/*.md`
  - Prompt policy and agent behavior files loaded at runtime.
- `AI/backend/constants.js`
  - AI identity, event names, and directive token regex.
- `AI/backend/instructions.js`
  - Instruction loader with cache.
- `AI/backend/provider.js`
  - AI provider client (Ollama/OpenAI-compatible), including streaming support.
- `AI/backend/events.js`
  - Realtime socket event emitters for AI status/stream updates.
- `AI/backend/agent.js`
  - Main AI agent orchestration: prompt build, stream events, directive execution, reply persistence.
- `AI/backend/tools.js`
  - Agent tools: contact-intent routing, reminders/tasks, memory, and web retrieval.

## Runtime Flow

1. User sends a message to AI contact.
2. Backend stores user message.
3. `processAiTurn` builds context + instructions + history.
4. Provider streams model output.
5. Realtime events are emitted:
   - `ai:status` (`thinking`, `streaming`, `done`, `error`)
   - `ai:stream` (incremental content/thinking text)
6. Final AI response is stored as a message.
7. If directive token is present, backend can send a message to a contact on user behalf.

## Environment

- `AI_BASE_URL` (or `OLLAMA_BASE_URL`)
  - Can be root URL (for example `https://your-ngrok-url`), backend resolves endpoint automatically.
- `AI_MODEL` (or `OLLAMA_MODEL`)
  - Example: `ministral-3:14b`
- `AI_KEEP_ALIVE`
  - Example: `30m` (keeps model warm on Ollama to reduce first-token delay)
- `AI_API_KEY` (optional, for providers that require Bearer auth)
- `AI_TIMEOUT_MS`
- `AI_TEMPERATURE`
- `SEARCH_API_KEY` (Serper API key)
- `SEARCH_TIMEOUT_MS`

## Notes

- Ollama model discovery checks `/api/tags`, `/api/ps`, and `/v1/models`.
- If your endpoint returns no model catalog data, runtime falls back to a safe model candidate list.
- When all candidates fail, backend error messages include attempted model tags and discovered catalog entries for easier debugging.
- Search directives are supported via token format:
  - `<search?quary?text?="{your query}">`
  - Supported modes include `text`, `image`, `videos`, `places`, `maps`, `reviews`, `news`, `shopping`, `lens`, `scholar`, `patents`, `autocomplete`, and `webpage`.
