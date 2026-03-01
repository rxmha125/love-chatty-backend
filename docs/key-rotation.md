# API Key Rotation Runbook (Groq / Serper)

This step is manual and must be done in provider dashboards.

## Why
Real keys were exposed during development and chat logs. Rotate them before production deploy.

## Groq
1. Create a new API key in Groq console.
2. Add it to backend env (`GROQ_API_KEY`, `GROQ_API_KEY_2`, etc.).
3. Restart backend.
4. Verify `/api/health` still works and AI replies succeed.
5. Revoke old keys in Groq console.

## Serper
1. Create a new Serper API key.
2. Update backend env `SEARCH_API_KEY`.
3. Restart backend.
4. Test a search command in AI chat.
5. Revoke old Serper key.

## Verification checklist
- Backend `/api/health` returns `search_enabled: true`
- AI response works with Groq
- AI web search results render correctly
- No old key values remain in local env files or deployment dashboard
