# Deployment Readiness Runbook (Section 2)

This file covers the practical steps for checklist `## 2`.

## What is already prepared in code
- `frontend/vercel.json` (SPA rewrite + asset caching)
- `backend/render.yaml` (Render blueprint)
- env templates for dev/staging/prod in both `frontend/` and `backend/`
- production env validators:
  - `backend/scripts/validate-production-env.mjs`
  - `frontend/scripts/validate-production-env.mjs`
- production smoke script (health + socket + auth + chat + AI + uploads):
  - `backend/scripts/smoke-production.mjs`
- backend health endpoint: `/api/health`
- upload storage decision doc: `backend/docs/upload-storage-strategy.md`

## Pre-deploy validation (run locally before pushing)
### Backend env
- Template sanity check:
  - `node backend/scripts/validate-production-env.mjs --file=backend/.env.production.example --allow-placeholders`
- Real backend production env file (strict):
  - `node backend/scripts/validate-production-env.mjs --file=backend/.env.production`

### Frontend env
- Template sanity check:
  - `node frontend/scripts/validate-production-env.mjs --file=frontend/.env.production.example --allow-placeholders`
- Real frontend production env file (strict):
  - `node frontend/scripts/validate-production-env.mjs --file=frontend/.env.production`

## Manual steps still required (cannot be done from repo code)
1. Rotate Groq/Serper keys in provider dashboards (`backend/docs/key-rotation.md`)
2. Create production MongoDB (Atlas or managed)
3. Deploy backend (Render/Railway/etc.)
4. Deploy frontend (Vercel)
5. Set real frontend/backend URLs in host env vars
6. Run production smoke checks against live backend

## After both deployments are live
Run smoke checks:
- Basic:
  - `node backend/scripts/smoke-production.mjs --base=https://<backend-domain>`
- With auth/socket/chat/AI/uploads:
  - set envs below, then run the same command

Optional smoke envs:
- `SMOKE_SOCKET_TOKEN`, `SMOKE_SOCKET_USER_UUID`
- `SMOKE_AUTH_TOKEN`, `SMOKE_AUTH_USER_UUID`
- `SMOKE_PEER_UUID`
- `SMOKE_AI_UUID` (optional; defaults to `ai-assistant`)
- `SMOKE_OPS_TOKEN` (for `/api/ops/metrics` smoke)

Optional flags:
- `--skip-ai`
- `--skip-uploads`

Ops metrics smoke:

- `node backend/scripts/ops-metrics-smoke.mjs --base=https://<backend-domain> --token=<OPS_METRICS_TOKEN>`

## Upload storage decision
Current production strategy is MongoDB GridFS (`backend/docs/upload-storage-strategy.md`).
This is confirmed for the first production release.
