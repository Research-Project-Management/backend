import type { Server, Socket } from 'socket.io';

export const WS_ROOM_PREFIXES = {
  PROJECT: 'project',
  DOC: 'doc',
  USER: 'user',
  CONVERSATION: 'conv',
} as const;

export function formatProjectRoom(projectId: string): string {
  return `${WS_ROOM_PREFIXES.PROJECT}:${projectId}`;
}

export function formatDocRoom(projectId: string, docId: string): string {
  return `${WS_ROOM_PREFIXES.DOC}:${projectId}:${docId}`;
}

export function formatUserRoom(userId: string): string {
  return `${WS_ROOM_PREFIXES.USER}:${userId}`;
}

export function formatConversationRoom(conversationId: string): string {
  return `${WS_ROOM_PREFIXES.CONVERSATION}:${conversationId}`;
}

export function isSocketInRoom(client: Socket, room: string): boolean {
  return Boolean(client.rooms?.has(room));
}

export function emitToLocalRoom(
  server: Server | undefined,
  room: string | string[],
  event: string,
  payload: unknown,
): void {
  if (!server) {
    return;
  }
  if (Array.isArray(room) && room.length === 0) {
    return;
  }

  const broadcaster = server.local ?? server;
  if (typeof broadcaster.to === 'function') {
    broadcaster.to(room).emit(event, payload);
  }
}

/**
 * Room eviction across Socket.IO cluster or local-only sockets (when triggered by cross-node bus).
 */
export async function evictUserFromRoom(
  server: Server | undefined,
  room: string,
  userId: string,
  notifyEvent?: string,
  notifyPayload?: unknown,
  options?: { localOnly?: boolean },
): Promise<number> {
  if (!server) {
    return 0;
  }

  const target = options?.localOnly ? (server.local ?? server) : server;
  if (typeof target.in !== 'function') {
    return 0;
  }

  const sockets = await target.in(room).fetchSockets();
  let evictedCount = 0;

  for (const remoteSocket of sockets) {
    const socketUserId = (remoteSocket.data as { userId?: string } | undefined)
      ?.userId;
    if (socketUserId !== userId) {
      continue;
    }

    if (notifyEvent) {
      remoteSocket.emit(notifyEvent, notifyPayload);
    }
    remoteSocket.leave(room);
    evictedCount += 1;
  }

  return evictedCount;
}
