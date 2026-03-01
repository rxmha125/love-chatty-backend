import express from "express";
import userRoutes from "../../server/routes/users.js";
import groupRoutes from "../../server/routes/groups.js";
import messageRoutes from "../../server/routes/messages.js";
import settingsRoutes from "../../server/routes/settings.js";

const createIoStub = () => ({
  emitted: [],
  to(room) {
    return {
      emit: (event, payload) => {
        this.emitted.push({ room, event, payload });
      },
    };
  },
  emit(event, payload) {
    this.emitted.push({ room: null, event, payload });
  },
});

const createPresenceStub = () => ({
  isOnline: () => false,
  listOnlineUserIds: () => [],
});

export const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.set("io", createIoStub());
  app.set("presence", createPresenceStub());

  app.use("/api/users", userRoutes);
  app.use("/api/groups", groupRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));

  return app;
};

export const tokenForUuid = (uuid) => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ uuid })).toString("base64url");
  return `${header}.${payload}.signature`;
};

export const authHeaders = (uuid) => ({
  Authorization: `Bearer ${tokenForUuid(uuid)}`,
  "x-user-uuid": uuid,
});
