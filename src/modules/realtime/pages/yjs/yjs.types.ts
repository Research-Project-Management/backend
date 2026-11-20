import * as Y from 'yjs';

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

export const YJS_CLUSTER_CHANNEL = 'manuscript:crdt:cluster';
export const YJS_REDIS_SNAPSHOT_TTL_SECONDS = 7 * 24 * 3600;

export function yjsDocKey(projectId: string, docId: string): string {
  return `${projectId}:${docId}`;
}

export function yjsRedisBinaryKey(projectId: string, docId: string): string {
  return `manuscript:crdt:bin:${projectId}:${docId}`;
}

export function yjsRedisMetaKey(projectId: string, docId: string): string {
  return `manuscript:crdt:meta:${projectId}:${docId}`;
}

export function yjsRedisFlushLockKey(projectId: string, docId: string): string {
  return `lock:yjs:flush:${projectId}:${docId}`;
}
