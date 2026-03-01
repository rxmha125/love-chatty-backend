import { io as createSocket } from "socket.io-client";

const args = process.argv.slice(2);
const getArg = (name, fallback = "") => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const hasFlag = (flag) => args.includes(flag);

const baseUrl = String(getArg("--base", process.env.SMOKE_BASE_URL || "")).trim().replace(/\/$/, "");
if (!baseUrl) {
  console.error("Usage: node backend/scripts/smoke-production.mjs --base=https://your-backend.example.com");
  process.exit(1);
}

const socketToken = String(process.env.SMOKE_SOCKET_TOKEN || "").trim();
const socketUserUuid = String(process.env.SMOKE_SOCKET_USER_UUID || "").trim();
const authToken = String(process.env.SMOKE_AUTH_TOKEN || "").trim();
const authUserUuid = String(process.env.SMOKE_AUTH_USER_UUID || "").trim();
const peerUuid = String(process.env.SMOKE_PEER_UUID || "").trim();
const testAiUuid = String(process.env.SMOKE_AI_UUID || "ai-assistant").trim();
const skipUploads = hasFlag("--skip-uploads");
const skipAi = hasFlag("--skip-ai");

const report = {
  base_url: baseUrl,
  checks: [],
};

const record = (name, status, details = {}) => {
  report.checks.push({ name, status, ...details });
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
};

const runUploadSmoke = async ({ baseUrl: currentBaseUrl, headers }) => {
  const marker = `[smoke-upload] ${Date.now()}`;
  const form = new FormData();
  form.set("file", new Blob([marker], { type: "text/plain" }), `smoke-${Date.now()}.txt`);

  const uploadResponse = await fetchJson(`${currentBaseUrl}/api/uploads`, {
    method: "POST",
    headers: {
      Authorization: headers.Authorization,
      "x-user-uuid": headers["x-user-uuid"],
    },
    body: form,
  });

  if (!uploadResponse.response.ok || !uploadResponse.body?.success) {
    record("uploads", "fail", {
      status: uploadResponse.response.status,
      body: uploadResponse.body,
    });
    return;
  }

  const relativeUrl = String(uploadResponse.body?.file_url || "").trim();
  if (!relativeUrl) {
    record("uploads", "fail", {
      reason: "Upload succeeded but file_url missing",
      body: uploadResponse.body,
    });
    return;
  }

  record("uploads", "pass", {
    file_id: uploadResponse.body?.file_id || null,
    file_url: relativeUrl,
    file_type: uploadResponse.body?.file_type || null,
  });

  const fileFetchResponse = await fetch(`${currentBaseUrl}${relativeUrl}`);
  if (!fileFetchResponse.ok) {
    record("uploads_fetch", "fail", {
      status: fileFetchResponse.status,
      file_url: relativeUrl,
    });
    return;
  }

  const downloaded = await fileFetchResponse.text();
  if (!downloaded.includes(marker)) {
    record("uploads_fetch", "fail", {
      reason: "Uploaded file content mismatch",
      file_url: relativeUrl,
    });
    return;
  }

  record("uploads_fetch", "pass", {
    file_url: relativeUrl,
    bytes: downloaded.length,
  });
};

const run = async () => {
  try {
    const health = await fetchJson(`${baseUrl}/api/health`);
    if (!health.response.ok || health.body?.success !== true) {
      record("health", "fail", { status: health.response.status, body: health.body });
      throw new Error("Health check failed");
    }
    record("health", "pass", {
      status: health.response.status,
      ai_provider: health.body?.ai_runtime?.provider || null,
      environment: health.body?.ai_runtime?.environment || null,
      search_enabled: health.body?.ai_runtime?.search_enabled || false,
    });

    if (socketToken && socketUserUuid) {
      const socketResult = await new Promise((resolve) => {
        const socket = createSocket(baseUrl, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          timeout: 10000,
          auth: {
            token: socketToken,
            userUuid: socketUserUuid,
          },
        });

        const timeout = setTimeout(() => {
          socket.close();
          resolve({ ok: false, reason: "timeout" });
        }, 12000);

        socket.on("connect", () => {
          clearTimeout(timeout);
          const transport = socket.io.engine?.transport?.name || null;
          socket.close();
          resolve({ ok: true, transport });
        });

        socket.on("connect_error", (error) => {
          clearTimeout(timeout);
          socket.close();
          resolve({ ok: false, reason: error?.message || "connect_error" });
        });
      });

      if (socketResult.ok) {
        record("socket_wss", "pass", { transport: socketResult.transport || null });
      } else {
        record("socket_wss", "fail", { reason: socketResult.reason || "unknown" });
      }
    } else {
      record("socket_wss", "skipped", { reason: "SMOKE_SOCKET_TOKEN/SMOKE_SOCKET_USER_UUID not set" });
    }

    if (authToken && authUserUuid) {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "x-user-uuid": authUserUuid,
      };

      const me = await fetchJson(`${baseUrl}/api/users/me`, { headers });
      if (me.response.ok && me.body?.success) {
        record("auth_me", "pass", { user_uuid: me.body?.user?.uuid || null });
      } else {
        record("auth_me", "fail", { status: me.response.status, body: me.body });
      }

      if (peerUuid) {
        const msg = await fetchJson(`${baseUrl}/api/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ receiver_id: peerUuid, content: `[smoke] ${Date.now()}` }),
        });
        if (msg.response.ok && msg.body?.success) {
          record("chat_send", "pass", { message_id: msg.body?.message?.id || null });
        } else {
          record("chat_send", "fail", { status: msg.response.status, body: msg.body });
        }
      } else {
        record("chat_send", "skipped", { reason: "SMOKE_PEER_UUID not set" });
      }

      if (!skipAi) {
        const aiMsg = await fetchJson(`${baseUrl}/api/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ receiver_id: testAiUuid, content: "Reply with OK" }),
        });
        if (aiMsg.response.ok && aiMsg.body?.success) {
          record("ai_send", "pass", { message_id: aiMsg.body?.message?.id || null });
        } else {
          record("ai_send", "fail", { status: aiMsg.response.status, body: aiMsg.body });
        }
      } else {
        record("ai_send", "skipped", { reason: "--skip-ai flag set" });
      }

      if (!skipUploads) {
        await runUploadSmoke({ baseUrl, headers });
      } else {
        record("uploads", "skipped", { reason: "--skip-uploads flag set" });
        record("uploads_fetch", "skipped", { reason: "--skip-uploads flag set" });
      }
    } else {
      record("auth_me", "skipped", { reason: "SMOKE_AUTH_TOKEN/SMOKE_AUTH_USER_UUID not set" });
      record("chat_send", "skipped", { reason: "SMOKE_AUTH_TOKEN/SMOKE_AUTH_USER_UUID not set" });
      record("ai_send", "skipped", { reason: "SMOKE_AUTH_TOKEN/SMOKE_AUTH_USER_UUID not set" });
      record("uploads", "skipped", { reason: "SMOKE_AUTH_TOKEN/SMOKE_AUTH_USER_UUID not set" });
      record("uploads_fetch", "skipped", { reason: "SMOKE_AUTH_TOKEN/SMOKE_AUTH_USER_UUID not set" });
    }
  } catch (error) {
    record("runner", "fail", { error: error instanceof Error ? error.message : String(error) });
  }

  const hasFail = report.checks.some((check) => check.status === "fail");
  console.log(JSON.stringify(report, null, 2));
  process.exit(hasFail ? 1 : 0);
};

run();
