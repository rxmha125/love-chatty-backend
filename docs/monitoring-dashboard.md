# Monitoring Dashboard (Basic Production)

This runbook finalizes the `Basic monitoring dashboard ready` checklist item.

## 1) Enable ops metrics endpoint
Set these backend env vars:

- `OPS_METRICS_ENABLED=true`
- `OPS_METRICS_TOKEN=<long-random-secret>`

Endpoint:

- `GET /api/ops/metrics`
- Header: `x-ops-token: <OPS_METRICS_TOKEN>`

The response includes:

- process uptime / memory / cpu
- request totals + status classes + top routes
- socket connected clients + online users
- error totals + recent errors

## 2) Smoke check

```bash
node backend/scripts/ops-metrics-smoke.mjs --base=https://<backend-domain> --token=<OPS_METRICS_TOKEN>
```

## 3) Suggested dashboard panels

Use any monitoring UI (Grafana, Datadog, Better Stack, etc.) and chart:

1. `metrics.process.uptime_sec`
2. `metrics.process.memory.heap_used_mb`
3. `metrics.requests.total` (delta/min)
4. `metrics.requests.by_status_class.5xx`
5. `metrics.requests.duration.avg_ms`
6. `metrics.sockets.connected_clients`
7. `metrics.errors.total` (delta/min)

## 4) Alert thresholds (starter)

- `5xx` > 20 in 5m => `critical`
- avg request duration > 1500ms for 10m => `warning`
- memory heap used > 85% of heap total for 10m => `warning`
- socket connected clients drops to 0 during active hours => `warning`

## 5) Extra health checks

- `GET /api/health` every 1 minute (uptime monitor)
- `GET /api/ops/metrics` every 2-5 minutes (authenticated monitor)

