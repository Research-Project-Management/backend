/**
 * modules/realtime/pages/yjs-cluster-relay.helper.ts
 * Redis binary snapshot persistence and multi-instance cluster pub/sub relay helpers for YjsService.
 */

import { Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { RedisCacheService } from '@/core';
import { YjsCursorDiffEngine } from './yjs-cursor-diff.engine';
import { REALTIME_EVENTS } from '../core/realtime.constant';

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

export async function deleteRedisSnapshotHelper(
  redis: RedisCacheService | undefined,
  logger: Logger,
  projectId: string,
  docId: string,
): Promise<void> {
  if (redis && redis.isReady()) {
    try {
      await redis.del(yjsRedisBinaryKey(projectId, docId));
      await redis.del(yjsRedisMetaKey(projectId, docId));
    } catch (err: unknown) {
      logger.warn(
        `Failed to delete Redis CRDT snapshot for ${projectId}:${docId}: ${(err as Error)?.message}`,
      );
    }
  }
}

export async function saveBinaryToRedisHelper(
  redis: RedisCacheService | undefined,
  projectId: string,
  docId: string,
  doc: Y.Doc,
  rev?: number,
): Promise<void> {
  if (redis && redis.isReady()) {
    const binarySnapshot = Y.encodeStateAsUpdate(doc);
    await redis.setBuffer(
      yjsRedisBinaryKey(projectId, docId),
      Buffer.from(binarySnapshot),
      YJS_REDIS_SNAPSHOT_TTL_SECONDS,
    );
    if (typeof redis.set === 'function') {
      await redis
        .set(
          yjsRedisMetaKey(projectId, docId),
          { rev: rev ?? -1, updatedAt: Date.now() },
          YJS_REDIS_SNAPSHOT_TTL_SECONDS,
        )
        .catch(() => {});
    }
  }
}

export async function initRedisClusterRelayHelper(
  redis: RedisCacheService | undefined,
  logger: Logger,
  onRawMessage: (raw: string) => void,
): Promise<any> {
  if (!redis || !redis.isReady()) return null;
  const baseClient = redis.getClient?.();
  if (!baseClient || typeof baseClient.duplicate !== 'function') return null;

  try {
    const subscriber = baseClient.duplicate();
    subscriber.on('error', (err: Error) => {
      logger.warn(`Yjs Redis subscriber error: ${err.message}`);
    });
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== YJS_CLUSTER_CHANNEL) return;
      onRawMessage(raw);
    });
    if (typeof subscriber.subscribe === 'function') {
      await subscriber.subscribe(YJS_CLUSTER_CHANNEL);
    }
    return subscriber;
  } catch (err: unknown) {
    logger.warn(
      `Failed to initialize Yjs Redis pub/sub relay: ${(err as Error)?.message}`,
    );
    return null;
  }
}

export function publishClusterRelayHelper(
  redis: RedisCacheService | undefined,
  logger: Logger,
  instanceId: string,
  payload: Omit<YjsClusterRelayMessage, 'instanceId'>,
): void {
  if (!redis || !redis.isReady()) return;
  const client = redis.getClient?.();
  if (!client || typeof client.publish !== 'function') return;

  const fullMsg: YjsClusterRelayMessage = {
    instanceId,
    ...payload,
  };
  Promise.resolve(
    client.publish(YJS_CLUSTER_CHANNEL, JSON.stringify(fullMsg)),
  ).catch((err: unknown) => {
    logger.warn(
      `Failed to publish Yjs cluster relay message: ${(err as Error)?.message}`,
    );
  });
}

export function handleClusterRelayMessageHelper(
  ctx: {
    instanceId: string;
    activeDocs: Map<string, ActiveDocSession>;
    projectDocKeys: Map<string, Set<string>>;
    server: Server | null;
    redis?: RedisCacheService;
    logger: Logger;
  },
  msg: YjsClusterRelayMessage,
): void {
  if (!msg || msg.instanceId === ctx.instanceId) return;
  const key = yjsDocKey(msg.projectId, msg.docId);
  const session = ctx.activeDocs.get(key);
  if (!session) return;

  if (msg.type === 'evict') {
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = undefined;
    }
    ctx.activeDocs.delete(key);
    ctx.projectDocKeys.get(msg.projectId)?.delete(key);
    session.doc.destroy();
    return;
  }

  if (msg.type === 'external-text' && typeof msg.text === 'string') {
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = undefined;
    }
    session.firstUnflushedAt = undefined;
    session.lastFlushedRev = undefined;
    const current = session.yText.toString();
    let captured: Uint8Array | null = null;
    if (current !== msg.text) {
      const capture = (update: Uint8Array) => {
        captured = captured ? Y.mergeUpdates([captured, update]) : update;
      };
      session.doc.on('update', capture);
      try {
        YjsCursorDiffEngine.applyEditsToYText(
          session.doc,
          session.yText,
          current,
          msg.text,
          'cluster-relay',
        );
      } finally {
        session.doc.off('update', capture);
      }
    }
    session.lastFlushedText = msg.text;
    if (captured) {
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, captured);
      const frame = Buffer.from(encoding.toUint8Array(encoder));
      if (ctx.server) {
        ctx.server
          .to(`doc:${msg.projectId}:${msg.docId}`)
          .emit(REALTIME_EVENTS.YJS_SYNC_UPDATE, {
            spaceId: msg.projectId,
            docId: msg.docId,
            data: frame,
          });
      }
    }
    if (ctx.redis && ctx.redis.isReady()) {
      void saveBinaryToRedisHelper(
        ctx.redis,
        msg.projectId,
        msg.docId,
        session.doc,
        session.lastFlushedRev,
      ).catch((err: unknown) => {
        ctx.logger.warn(
          `Failed to persist external-text cluster relay Y.Doc to Redis for ${msg.projectId}:${msg.docId}: ${(err as Error)?.message}`,
        );
      });
    }
    return;
  }

  if (msg.type === 'yjs-update' && msg.updateBase64) {
    const updateBuf = Buffer.from(msg.updateBase64, 'base64');
    if (updateBuf.length > 0) {
      Y.applyUpdate(session.doc, updateBuf, 'cluster-relay');
      session.lastActiveAt = Date.now();
    }
  }
}
