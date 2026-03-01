# Backend Deploy (Render)

## Repo root for Render
Push only the `backend/` folder contents to the backend repo (or use Render root directory = `backend`).

## Option A (recommended)
Use `backend/render.yaml` Blueprint.

## Option B (manual Web Service)
- Environment: `Node`
- Build command: `npm install`
- Start command: `npm run start`
- Health check path: `/api/health`

## Validate env before deploy
- Template check:
  - `node scripts/validate-production-env.mjs --file=.env.production.example --allow-placeholders`
- Real production env check:
  - `node scripts/validate-production-env.mjs --file=.env.production`

## Required env vars
Use `backend/.env.production.example` as the source of truth. At minimum set:
- `MONGODB_URI`
- `MONGODB_DB`
- `CLIENT_ORIGINS` (your Vercel + custom domain frontend URLs)
- `GROQ_API_KEY` (and optional `GROQ_API_KEY_2...`)
- `SEARCH_API_KEY`
- `OPS_METRICS_ENABLED=true`
- `OPS_METRICS_TOKEN=<long-random-secret>`

## After deploy
1. Open `/api/health`
2. Confirm `status: ok`
3. Confirm `ai_runtime.environment` = `production`
4. Confirm `search_enabled: true`
5. Use the backend URL in frontend `VITE_API_BASE_URL` and `VITE_SOCKET_URL`
6. Run smoke test:
   - `node scripts/smoke-production.mjs --base=https://<backend-domain>`
7. Run ops metrics smoke:
   - `node scripts/ops-metrics-smoke.mjs --base=https://<backend-domain> --token=<OPS_METRICS_TOKEN>`
