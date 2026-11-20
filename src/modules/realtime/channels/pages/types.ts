import type * as Y from 'yjs';

export interface CursorPosition {
  row: number;
  column: number;
  selection?: {
    anchor: { row: number; column: number };
    head: { row: number; column: number };
  } | null;
}

export interface UserPresence {
  userId: string;
  socketId: string;
  spaceId: string;
  name?: string | null;
  color?: string | null;
  avatar?: string | null;
  activeDocId?: string | null;
  cursor?: CursorPosition | null;
  lastHeartbeat: number;
}

export interface ClientSocketData {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  spaceId?: string | null;
  pageId?: string;
  activeDocId?: string | null;
  authenticated: boolean;
}

export interface ActiveDocSession {
  doc: Y.Doc;
  yText: Y.Text;
  projectId: string;
  docId: string;
  flushTimeout?: NodeJS.Timeout;
  lastActiveAt: number;
  firstUnflushedAt?: number;
  currentVersion?: number;
  lastFlushedRev?: number;
  lastFlushedText?: string;
  approxEncodedBytes?: number;
}

export interface SyncMessageResult {
  reply?: Buffer | null;
  broadcastUpdate?: Buffer | null;
  msgType?: number;
}

export interface YjsClusterRelayMessage {
  instanceId: string;
  type: 'yjs-update' | 'external-text' | 'evict';
  projectId: string;
  docId: string;
  updateBase64?: string;
  text?: string;
}

export function yjsDocKey(projectId: string, docId: string): string {
  return `${projectId}:${docId}`;
}
