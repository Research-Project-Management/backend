/**
 * realtime/dto/server-event.dto.ts
 * Outbound WebSocket server event packet definitions.
 */

export interface UserPresenceDto {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  avatar: string | null;
  activeDocId: string | null;
  cursor: {
    row: number;
    column: number;
    selection: {
      anchor: { row: number; column: number };
      head: { row: number; column: number };
    } | null;
  } | null;
  lastSeenAt: string;
}

export interface DocUpdateAckDto {
  docId: string;
  clientRev: number;
  serverRev: number;
  version: number;
  inFlightSeq: number;
}

export interface DocUpdateBroadcastDto {
  docId: string;
  clientRev: number;
  serverRev: number;
  version: number;
  inFlightSeq: number;
  lines?: string[] | null;
  splice?: {
    startLine: number;
    deleteCount: number;
    newLines: string[];
  } | null;
  userId: string;
}

export interface ProjectUserJoinedDto {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  avatar: string | null;
}

export interface ProjectUserLeftDto {
  userId: string;
  socketId: string;
}
