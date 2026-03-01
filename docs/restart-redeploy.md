# Backend Restart / Redeploy Runbook

This file closes the `Backend restart/redeploy process documented` item.

## Restart only (same build)

Use your host's restart action:

- Render: Web Service -> `Manual Deploy` -> `Restart service`
- Railway/Fly/VPS: restart process manager (`pm2 restart`, `systemctl restart`, etc.)

Then verify:

1. `GET /api/health` returns `success: true`
2. Socket can connect (`node backend/scripts/smoke-production.mjs --base=https://<backend-domain>`)
3. Optional ops endpoint:
   - `node backend/scripts/ops-metrics-smoke.mjs --base=https://<backend-domain> --token=<OPS_METRICS_TOKEN>`

## Redeploy after code/env changes

1. Validate env:
   - `node backend/scripts/validate-production-env.mjs --file=backend/.env.production`
2. Run tests:
   - `npm run test --prefix backend`
3. Deploy from host (Render manual deploy / Git push auto deploy)
4. Run smoke:
   - `node backend/scripts/smoke-production.mjs --base=https://<backend-domain>`
5. Confirm logs show:
   - server started
   - no repeated startup errors

## Zero-downtime guidance

- Prefer rolling deploy if host supports it
- Keep DB migrations backward-compatible
- Avoid deleting env vars in the same deploy as code changes

