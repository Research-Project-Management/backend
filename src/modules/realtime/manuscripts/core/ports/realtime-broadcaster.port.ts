/**
 * realtime/core/ports/realtime-broadcaster.port.ts
 * Outbound Port (SPI) for broadcasting WebSocket packets to rooms or individual sockets.
 */

export abstract class IRealtimeBroadcasterPort {
  /**
   * Broadcasts an event to all connected sockets in a project room.
   */
  abstract broadcastToProject(
    projectId: string,
    event: string,
    payload: any,
    excludeSocketId?: string,
  ): void;

  /**
   * Broadcasts an event to all connected sockets currently viewing a specific document.
   */
  abstract broadcastToDoc(
    projectId: string,
    docId: string,
    event: string,
    payload: any,
    excludeSocketId?: string,
  ): void;

  /**
   * Sends a targeted message to a single specific socket client.
   */
  abstract sendToSocket(socketId: string, event: string, payload: any): void;
}
