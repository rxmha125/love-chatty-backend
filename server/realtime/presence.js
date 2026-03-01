export class PresenceStore {
  constructor() {
    this.userSockets = new Map();
  }

  add(userUuid, socketId) {
    if (!this.userSockets.has(userUuid)) {
      this.userSockets.set(userUuid, new Set());
    }

    this.userSockets.get(userUuid).add(socketId);
  }

  remove(userUuid, socketId) {
    const sockets = this.userSockets.get(userUuid);
    if (!sockets) {
      return;
    }

    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.userSockets.delete(userUuid);
    }
  }

  isOnline(userUuid) {
    return this.userSockets.has(userUuid);
  }

  listOnlineUserIds() {
    return Array.from(this.userSockets.keys());
  }
}

export const userRoom = (userUuid) => `user:${userUuid}`;
export const groupRoom = (groupUuid) => `group:${groupUuid}`;
