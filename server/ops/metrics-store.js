const MAX_RECENT_ERRORS = 50;
const MAX_ROUTE_KEYS = 300;

const normalizePathForMetrics = (rawPath) => {
  const pathname = String(rawPath || "").split("?")[0] || "/";
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/\/\d+/g, "/:id");
};

const floorTo = (value, precision = 2) => {
  const factor = 10 ** precision;
  return Math.round(Number(value || 0) * factor) / factor;
};

export class OpsMetricsStore {
  constructor() {
    this.startedAt = Date.now();
    this.requestsTotal = 0;
    this.responsesByClass = {
      "1xx": 0,
      "2xx": 0,
      "3xx": 0,
      "4xx": 0,
      "5xx": 0,
    };
    this.requestDurationTotalMs = 0;
    this.requestDurationMaxMs = 0;
    this.requestDurationMinMs = Number.POSITIVE_INFINITY;
    this.routeStats = new Map();
    this.errorTotal = 0;
    this.recentErrors = [];
  }

  recordRequest({ method, path, status, durationMs }) {
    const safeStatus = Number.isFinite(Number(status)) ? Number(status) : 0;
    const safeDurationMs = Math.max(0, Number(durationMs || 0));
    const statusClass = `${Math.floor(safeStatus / 100)}xx`;
    const routeKey = `${String(method || "GET").toUpperCase()} ${normalizePathForMetrics(path)}`;

    this.requestsTotal += 1;
    this.responsesByClass[statusClass] = (this.responsesByClass[statusClass] || 0) + 1;
    this.requestDurationTotalMs += safeDurationMs;
    this.requestDurationMaxMs = Math.max(this.requestDurationMaxMs, safeDurationMs);
    this.requestDurationMinMs = Math.min(this.requestDurationMinMs, safeDurationMs);

    if (!this.routeStats.has(routeKey) && this.routeStats.size >= MAX_ROUTE_KEYS) {
      const oldestKey = this.routeStats.keys().next().value;
      if (oldestKey) {
        this.routeStats.delete(oldestKey);
      }
    }

    const current = this.routeStats.get(routeKey) || {
      count: 0,
      total_ms: 0,
      max_ms: 0,
      last_status: 0,
      last_at: null,
    };
    current.count += 1;
    current.total_ms += safeDurationMs;
    current.max_ms = Math.max(current.max_ms, safeDurationMs);
    current.last_status = safeStatus;
    current.last_at = new Date().toISOString();
    this.routeStats.set(routeKey, current);
  }

  recordError({ requestId, method, path, error }) {
    this.errorTotal += 1;

    const message = error?.message
      ? String(error.message)
      : String(error || "Unknown error");

    this.recentErrors.unshift({
      at: new Date().toISOString(),
      request_id: requestId || null,
      method: String(method || "").toUpperCase(),
      path: normalizePathForMetrics(path),
      message: message.slice(0, 500),
    });

    if (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.length = MAX_RECENT_ERRORS;
    }
  }

  snapshot({ io, presence } = {}) {
    const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000);
    const avgDurationMs = this.requestsTotal > 0
      ? this.requestDurationTotalMs / this.requestsTotal
      : 0;
    const routeEntries = Array.from(this.routeStats.entries())
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        avg_ms: floorTo(stats.total_ms / Math.max(1, stats.count), 2),
        max_ms: floorTo(stats.max_ms, 2),
        last_status: stats.last_status,
        last_at: stats.last_at,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
      generated_at: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptime_sec: uptimeSec,
        node_version: process.version,
        platform: process.platform,
        memory: {
          rss_mb: floorTo(mem.rss / 1024 / 1024, 2),
          heap_used_mb: floorTo(mem.heapUsed / 1024 / 1024, 2),
          heap_total_mb: floorTo(mem.heapTotal / 1024 / 1024, 2),
          external_mb: floorTo(mem.external / 1024 / 1024, 2),
        },
        cpu: {
          user_ms: floorTo(cpu.user / 1000, 2),
          system_ms: floorTo(cpu.system / 1000, 2),
        },
        load_avg: process.platform === "win32"
          ? null
          : process.loadavg().map((value) => floorTo(value, 2)),
      },
      sockets: {
        connected_clients: Number(io?.engine?.clientsCount || 0),
        online_users: Array.isArray(presence?.listOnlineUserIds?.())
          ? presence.listOnlineUserIds().length
          : 0,
      },
      requests: {
        total: this.requestsTotal,
        by_status_class: this.responsesByClass,
        duration: {
          avg_ms: floorTo(avgDurationMs, 2),
          max_ms: floorTo(this.requestDurationMaxMs, 2),
          min_ms: Number.isFinite(this.requestDurationMinMs)
            ? floorTo(this.requestDurationMinMs, 2)
            : 0,
        },
        top_routes: routeEntries,
      },
      errors: {
        total: this.errorTotal,
        recent: this.recentErrors,
      },
    };
  }
}

export const opsMetricsStore = new OpsMetricsStore();
