/**
 * realtime/core/domain/exceptions/invalid-room.exception.ts
 * Thrown when an invalid project or document room is targeted by a client socket.
 */

export class InvalidRoomException extends Error {
  constructor(public readonly roomId: string, message?: string) {
    super(message || `Room '${roomId}' is invalid or no longer active.`);
    this.name = 'InvalidRoomException';
  }
}
