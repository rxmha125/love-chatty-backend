const args = process.argv.slice(2);
const getArg = (name, fallback = "") => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const baseUrl = String(getArg("--base", process.env.SMOKE_BASE_URL || "")).trim().replace(/\/$/, "");
const token = String(getArg("--token", process.env.SMOKE_OPS_TOKEN || "")).trim();

if (!baseUrl) {
  console.error("Usage: node backend/scripts/ops-metrics-smoke.mjs --base=https://your-backend.example.com [--token=OPS_TOKEN]");
  process.exit(1);
}

if (!token) {
  console.error("Missing ops token. Provide --token=... or SMOKE_OPS_TOKEN.");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/ops/metrics`, {
  headers: {
    "x-ops-token": token,
  },
});

let body = null;
try {
  body = await response.json();
} catch {
  body = null;
}

if (!response.ok || body?.success !== true) {
  console.error(JSON.stringify({
    success: false,
    status: response.status,
    body,
  }, null, 2));
  process.exit(1);
}

const metrics = body.metrics || {};
const checks = {
  has_process: Boolean(metrics.process),
  has_requests: Boolean(metrics.requests),
  has_errors: Boolean(metrics.errors),
  has_sockets: Boolean(metrics.sockets),
  has_generated_at: Boolean(metrics.generated_at),
};
const failedChecks = Object.entries(checks).filter(([, ok]) => !ok);

if (failedChecks.length > 0) {
  console.error(JSON.stringify({
    success: false,
    message: "Ops metrics response shape is invalid",
    failed_checks: failedChecks.map(([name]) => name),
    status: response.status,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  success: true,
  status: response.status,
  checks,
  sample: {
    generated_at: metrics.generated_at,
    uptime_sec: metrics.process?.uptime_sec ?? null,
    connected_clients: metrics.sockets?.connected_clients ?? null,
    requests_total: metrics.requests?.total ?? null,
    errors_total: metrics.errors?.total ?? null,
  },
}, null, 2));
