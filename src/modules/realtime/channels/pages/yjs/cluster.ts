import { Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import * as Y from 'yjs';
import { applyTextEditsAndCapture } from './util';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { RedisCacheService, RedisPubSubService } from '@/core';
import { emitToLocalRoom } from '../../../core/rooms';
import {
  PAGES_EVENTS,
  PAGES_REALTIME_DEFAULTS,
  PAGES_REDIS_CHANNELS,
  PAGES_REDIS_KEYS,
  PAGES_ROOMS,
} from '../config';
import {
  type ActiveDocSession,
  type YjsClusterRelayMessage,
  yjsDocKey,
} from '../types';

export function removeActiveDocSessionHelper(
  activeDocs: Map<string, ActiveDocSession>,
  projectDocKeys: Map<string, Set<string>>,
  projectId: string,
  key: string,
  session?: ActiveDocSession,
): void {
  const target = session ?? activeDocs.get(key);
  if (target?.flushTimeout) {
    clearTimeout(target.flushTimeout);
    target.flushTimeout = undefined;
  }
  activeDocs.delete(key);
  const projSet = projectDocKeys.get(projectId);
  if (projSet) {
    projSet.delete(key);
    if (projSet.size === 0) {
      projectDocKeys.delete(projectId);
    }
  }
  target?.doc.destroy();
}

const RELEASE_FLUSH_LOCK_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export async function acquireFlushLockHelper(
  redis: RedisCacheService | undefined,
  instanceId: string,
  projectId: string,
  docId: string,
  lockTtlMs: number = PAGES_REALTIME_DEFAULTS.yjs.flushLockTtlMs,
): Promise<boolean> {
  if (!redis || !redis.isReady()) return true;
  const client = redis.getClient?.();
  if (!client || typeof client.set !== 'function') return true;
  try {
    const lockKey = PAGES_REDIS_KEYS.yjsFlushLock(projectId, docId);
    const res = await client.set(lockKey, instanceId, 'PX', lockTtlMs, 'NX');
    return res === 'OK';
  } catch {
    return true;
  }
}

export async function releaseFlushLockHelper(
  redis: RedisCacheService | undefined,
  instanceId: string,
  projectId: string,
  docId: string,
): Promise<void> {
  if (!redis || !redis.isReady()) return;
  const client = redis.getClient?.() as
    | {
        eval?: (
          script: string,
          numKeys: number,
          key: string,
          arg: string,
        ) => Promise<unknown>;
        get?: (key: string) => Promise<string | null>;
        del?: (key: string) => Promise<unknown>;
      }
    | undefined;
  if (!client) return;
  try {
    const lockKey = PAGES_REDIS_KEYS.yjsFlushLock(projectId, docId);
    if (typeof client.eval === 'function') {
      await client.eval(RELEASE_FLUSH_LOCK_LUA, 1, lockKey, instanceId);
      return;
    }
    const owner = await client.get?.(lockKey);
    if (!owner || owner === instanceId) {
      await client.del?.(lockKey);
    }
  } catch {
    // Ignore lock release error
  }
}

export interface YjsRelaySubscriber {
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
}

export async function deleteRedisSnapshotHelper(
  redis: RedisCacheService | undefined,
  logger: Logger,
  projectId: string,
  docId: string,
): Promise<void> {
  if (redis && redis.isReady()) {
    try {
      await redis.del(PAGES_REDIS_KEYS.yjsBinary(projectId, docId));
      await redis.del(PAGES_REDIS_KEYS.yjsMeta(projectId, docId));
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
  snapshotTtlSeconds: number = PAGES_REALTIME_DEFAULTS.yjs
    .redisSnapshotTtlSeconds,
): Promise<void> {
  if (redis && redis.isReady()) {
    const binarySnapshot = Y.encodeStateAsUpdate(doc);
    await redis.setBuffer(
      PAGES_REDIS_KEYS.yjsBinary(projectId, docId),
      Buffer.from(binarySnapshot),
      snapshotTtlSeconds,
    );
    if (typeof redis.set === 'function') {
      await redis
        .set(
          PAGES_REDIS_KEYS.yjsMeta(projectId, docId),
          { rev: rev ?? -1, updatedAt: Date.now() },
          snapshotTtlSeconds,
        )
        .catch(() => {});
    }
  }
}

export async function initRedisClusterRelayHelper(
  redis: RedisCacheService | undefined,
  logger: Logger,
  onRawMessage: (raw: string) => void,
  pubSub?: RedisPubSubService,
): Promise<YjsRelaySubscriber | null> {
  if (pubSub?.isEnabled()) {
    const unsubscribe = await pubSub.subscribe(
      PAGES_REDIS_CHANNELS.YJS_CLUSTER,
      (_channel, raw) => onRawMessage(raw),
    );
    return {
      quit: unsubscribe,
      disconnect: () => {
        void unsubscribe();
      },
    };
  }

  if (!redis || !redis.isReady()) return null;
  const baseClient = redis.getClient?.();
  if (!baseClient || typeof baseClient.duplicate !== 'function') return null;

  try {
    const subscriber = baseClient.duplicate();
    subscriber.on('error', (err: Error) => {
      logger.warn(`Yjs Redis subscriber error: ${err.message}`);
    });
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== PAGES_REDIS_CHANNELS.YJS_CLUSTER) return;
      onRawMessage(raw);
    });
    if (typeof subscriber.subscribe === 'function') {
      await subscriber.subscribe(PAGES_REDIS_CHANNELS.YJS_CLUSTER);
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
  pubSub?: RedisPubSubService,
): void {
  const fullMsg: YjsClusterRelayMessage = {
    instanceId,
    ...payload,
  };

  if (pubSub?.isReady()) {
    void pubSub
      .publish(PAGES_REDIS_CHANNELS.YJS_CLUSTER, JSON.stringify(fullMsg))
      .catch((err: unknown) => {
        logger.warn(
          `Failed to publish Yjs cluster relay message: ${(err as Error)?.message}`,
        );
      });
    return;
  }

  if (!redis || !redis.isReady()) return;
  const client = redis.getClient?.();
  if (!client || typeof client.publish !== 'function') return;

  Promise.resolve(
    client.publish(PAGES_REDIS_CHANNELS.YJS_CLUSTER, JSON.stringify(fullMsg)),
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
    redisSnapshotTtlSeconds?: number;
  },
  msg: YjsClusterRelayMessage,
): void {
  if (!msg || msg.instanceId === ctx.instanceId) return;
  const key = yjsDocKey(msg.projectId, msg.docId);
  const session = ctx.activeDocs.get(key);
  if (!session) return;

  if (msg.type === 'evict') {
    removeActiveDocSessionHelper(
      ctx.activeDocs,
      ctx.projectDocKeys,
      msg.projectId,
      key,
      session,
    );
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
      captured = applyTextEditsAndCapture(
        session.doc,
        session.yText,
        current,
        msg.text,
        'cluster-relay',
      );
    }
    session.lastFlushedText = msg.text;
    if (captured) {
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, captured);
      const frame = Buffer.from(encoding.toUint8Array(encoder));
      if (ctx.server) {
        emitToLocalRoom(
          ctx.server,
          PAGES_ROOMS.doc(msg.projectId, msg.docId),
          PAGES_EVENTS.YJS_SYNC_UPDATE,
          {
            spaceId: msg.projectId,
            docId: msg.docId,
            data: frame,
          },
        );
      }
    }
    if (ctx.redis && ctx.redis.isReady()) {
      void saveBinaryToRedisHelper(
        ctx.redis,
        msg.projectId,
        msg.docId,
        session.doc,
        session.lastFlushedRev,
        ctx.redisSnapshotTtlSeconds,
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
