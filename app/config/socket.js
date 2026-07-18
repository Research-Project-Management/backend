import { Server } from "socket.io";

let _io = null;

const CORS_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:2915",
  "http://localhost:2916",
  "http://localhost:3000",
  "https://flux.aisq.dev",
  "https://flux.aisq.site",
];
const presence = new Map();

function getRoomPresence(roomId) {
  const users = [];
  for (const [socketId, rooms] of presence) {
    if (rooms.has(roomId)) {
      users.push({ socketId, ...rooms.get(roomId) });
    }
  }
  return users;
}

export function initSocket(server) {
  _io = new Server(server, {
    cors: {
      origin: CORS_ORIGINS,
      credentials: true,
    },
  });

  _io.on("connection", (socket) => {
    socket.on("join:page", (pageId) => {
      if (!pageId) return;
      socket.join(`page:${pageId}`);
      const roomId = `page:${pageId}`;
      socket.emit("presence:update", {
        roomId,
        users: getRoomPresence(roomId),
      });
    });
    socket.on(
      "join:project",
      (projectId) => projectId && socket.join(`project:${projectId}`),
    );
    socket.on(
      "join:workspace",
      (workspaceId) => workspaceId && socket.join(`workspace:${workspaceId}`),
    );
    socket.on(
      "join:user",
      (userId) => userId && socket.join(`user:${userId}`),
    );
    socket.on(
      "leave:page",
      (pageId) => pageId && socket.leave(`page:${pageId}`),
    );
    socket.on(
      "leave:project",
      (projectId) => projectId && socket.leave(`project:${projectId}`),
    );
    socket.on(
      "leave:workspace",
      (workspaceId) => workspaceId && socket.leave(`workspace:${workspaceId}`),
    );
    socket.on(
      "leave:user",
      (userId) => userId && socket.leave(`user:${userId}`),
    );

    socket.on("presence:join", ({ roomId, user } = {}) => {
      if (!roomId || !user) return;
      socket.join(roomId);
      if (!presence.has(socket.id)) presence.set(socket.id, new Map());
      presence.get(socket.id).set(roomId, user);
      _io
        .to(roomId)
        .emit("presence:update", { roomId, users: getRoomPresence(roomId) });
    });

    socket.on("presence:leave", ({ roomId } = {}) => {
      if (!roomId) return;
      presence.get(socket.id)?.delete(roomId);
      _io
        .to(roomId)
        .emit("presence:update", { roomId, users: getRoomPresence(roomId) });
    });

    socket.on("page:content", ({ pageId, content } = {}) => {
      if (!pageId || content === undefined) return;
      socket.to(`page:${pageId}`).emit("page:content", { pageId, content });
    });

    socket.on("page:cursor", ({ pageId, line, column } = {}) => {
      if (!pageId || line == null || column == null) return;
      socket
        .to(`page:${pageId}`)
        .emit("page:cursor", { socketId: socket.id, pageId, line, column });
    });

    socket.on("disconnect", () => {
      const rooms = presence.get(socket.id);
      if (rooms) {
        for (const [roomId] of rooms) {
          rooms.delete(roomId);
          _io.to(roomId).emit("presence:update", {
            roomId,
            users: getRoomPresence(roomId),
          });
        }
        presence.delete(socket.id);
      }
    });
  });

  return _io;
}

export function getIO() {
  return _io;
}
