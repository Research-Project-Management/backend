import { Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import * as Y from 'yjs';
import { applyTextEditsAndCapture } from './util';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { RedisCacheService, RedisPubSubService } from '@/core';
import {
  DocNotFoundError,
  DocstoreService,
  LineArray,
} from '@/modules/pages/docstore';
import { PAGES_EVENTS, PAGES_REDIS_KEYS, PAGES_ROOMS } from '../config';
import { mergeThreeWayText } from './merge';
import {
  type ActiveDocSession,
  type YjsClusterRelayMessage,
  yjsDocKey,
} from '../types';
import {
  acquireFlushLockHelper,
  deleteRedisSnapshotHelper,
  publishClusterRelayHelper,
  releaseFlushLockHelper,
  removeActiveDocSessionHelper,
  saveBinaryToRedisHelper,
} from './cluster';

export interface YjsPersistenceContext {
  readonly instanceId: string;
  readonly logger: Logger;
  readonly redis?: RedisCacheService;
  readonly pubSub?: RedisPubSubService;
  readonly docstoreService?: DocstoreService;
  readonly server: Server | null;
  readonly activeDocs: Map<string, ActiveDocSession>;
  readonly projectDocKeys: Map<string, Set<string>>;
  readonly inFlightFlushes: Map<string, Promise<void>>;
  readonly flushDebounceMs: number;
  readonly flushRetryDelayMs: number;
  readonly flushLockTtlMs: number;
  readonly redisSnapshotTtlSeconds: number;
  readonly flushDoc: (projectId: string, docId: string) => Promise<void>;
  readonly evictDoc: (
    projectId: string,
    docId: string,
    options?: { skipFlush?: boolean },
  ) => Promise<void>;
  readonly onDocUpdated: (
    projectId: string,
    docId: string,
    session: ActiveDocSession,
  ) => void;
}

export async function hydrateOrInitYDocSessionHelper(
  ctx: YjsPersistenceContext,
  projectId: string,
  docId: string,
): Promise<ActiveDocSession> {
  const key = yjsDocKey(projectId, docId);
  const doc = new Y.Doc();
  const yText = doc.getText('latex');

  let loadedFromRedis = false;
  let baselineDocRecord: {
    lines?: string[];
    rev?: number;
    version?: number;
  } | null = null;
  if (ctx.redis && ctx.redis.isReady()) {
    try {
      const rawBuffer = await ctx.redis.getBuffer(
        PAGES_REDIS_KEYS.yjsBinary(projectId, docId),
      );
      if (rawBuffer && rawBuffer.length > 0) {
        let redisIsStale = false;
        if (
          ctx.docstoreService &&
          typeof ctx.docstoreService.getDoc === 'function'
        ) {
          const meta =
            typeof ctx.redis.get === 'function'
              ? await ctx.redis
                  .get<{ rev?: number }>(
                    PAGES_REDIS_KEYS.yjsMeta(projectId, docId),
                  )
                  .catch(() => null)
              : null;
          baselineDocRecord = await ctx.docstoreService.getDoc(
            projectId,
            docId,
          );
          if (
            !meta ||
            typeof meta.rev !== 'number' ||
            meta.rev < 0 ||
            (baselineDocRecord?.rev !== undefined &&
              baselineDocRecord.rev > meta.rev)
          ) {
            redisIsStale = true;
            ctx.logger.warn(
              `Discarding stale/unversioned Redis Y.Doc snapshot for ${key} (redis rev=${meta?.rev ?? 'none'} < docstore rev=${baselineDocRecord?.rev ?? 'unknown'})`,
            );
            await deleteRedisSnapshotHelper(
              ctx.redis,
              ctx.logger,
              projectId,
              docId,
            );
          }
        }

        if (!redisIsStale) {
          Y.applyUpdate(doc, rawBuffer, 'redis-init');
          loadedFromRedis = true;
          ctx.logger.debug(
            `Hydrated Y.Doc from Redis binary cache: ${key} (${rawBuffer.length} bytes)`,
          );
        }
      }
    } catch (err: unknown) {
      if (
        err instanceof DocNotFoundError ||
        (err as { name?: string })?.name === 'DocNotFoundError'
      ) {
        await deleteRedisSnapshotHelper(
          ctx.redis,
          ctx.logger,
          projectId,
          docId,
        );
        throw err;
      }
      ctx.logger.warn(
        `Failed to read Y.Doc from Redis: ${(err as Error)?.message}`,
      );
    }
  }

  if (!loadedFromRedis && ctx.docstoreService) {
    let rawText: string | null = null;
    if (baselineDocRecord && Array.isArray(baselineDocRecord.lines)) {
      rawText = baselineDocRecord.lines.join('\n');
    } else if (typeof ctx.docstoreService.getDoc === 'function') {
      const res = await ctx.docstoreService.getDoc(projectId, docId);
      baselineDocRecord = res;
      rawText = Array.isArray(res?.lines) ? res.lines.join('\n') : '';
    }
    if (rawText && rawText.length > 0) {
      doc.transact(() => {
        yText.insert(0, rawText);
      }, 'docstore-init');
      ctx.logger.debug(
        `Hydrated Y.Doc from Docstore baseline (${rawText.length} chars): ${key}`,
      );
    }
  }

  const session: ActiveDocSession = {
    doc,
    yText,
    projectId,
    docId,
    lastActiveAt: Date.now(),
    lastFlushedText: yText.toString(),
    ...(baselineDocRecord?.rev !== undefined
      ? { lastFlushedRev: baselineDocRecord.rev }
      : {}),
    ...(baselineDocRecord?.version !== undefined
      ? { currentVersion: baselineDocRecord.version }
      : {}),
  };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (
      origin === 'redis-init' ||
      origin === 'docstore-init' ||
      origin === 'cluster-relay'
    ) {
      return;
    }
    if (origin === 'rest-api') {
      session.lastActiveAt = Date.now();
      session.lastFlushedText = session.yText.toString();
      return;
    }
    if (update && update.byteLength > 0) {
      publishClusterRelayHelper(
        ctx.redis,
        ctx.logger,
        ctx.instanceId,
        {
          type: 'yjs-update',
          projectId,
          docId,
          updateBase64: Buffer.from(update).toString('base64'),
        },
        ctx.pubSub,
      );
    }
    ctx.onDocUpdated(projectId, docId, session);
  });

  ctx.activeDocs.set(key, session);
  let projSet = ctx.projectDocKeys.get(projectId);
  if (!projSet) {
    projSet = new Set();
    ctx.projectDocKeys.set(projectId, projSet);
  }
  projSet.add(key);
  return session;
}

export async function executeFlushDocHelper(
  ctx: YjsPersistenceContext,
  projectId: string,
  docId: string,
  key: string,
  session: ActiveDocSession,
): Promise<void> {
  if (session.flushTimeout) {
    clearTimeout(session.flushTimeout);
    session.flushTimeout = undefined;
  }
  const flushedTimestamp = session.firstUnflushedAt;
  const flushedText = session.yText.toString();

  const hasLock = await acquireFlushLockHelper(
    ctx.redis,
    ctx.instanceId,
    projectId,
    docId,
    ctx.flushLockTtlMs,
  );
  if (!hasLock) {
    if (!session.flushTimeout) {
      session.flushTimeout = setTimeout(
        () => void ctx.flushDoc(projectId, docId),
        ctx.flushDebounceMs,
      );
      session.flushTimeout.unref?.();
    }
    return;
  }

  try {
    const tasks: Promise<unknown>[] = [];
    let convergedOnConflict = false;
    let docWasDeleted = false;

    if (ctx.docstoreService) {
      const lines = LineArray.textToLines(flushedText);
      if (
        session.currentVersion === undefined ||
        session.lastFlushedRev === undefined
      ) {
        const currentDoc = await ctx.docstoreService
          .getDoc(projectId, docId)
          .catch(() => null);
        session.currentVersion = currentDoc?.version ?? 0;
        session.lastFlushedRev = currentDoc?.rev;
      }
      const nextVersion = (session.currentVersion ?? 0) + 1;

      tasks.push(
        ctx.docstoreService
          .updateDoc(projectId, docId, {
            lines,
            version: nextVersion,
            expectedRev: session.lastFlushedRev,
          })
          .then((res) => {
            session.currentVersion = res.doc?.version ?? nextVersion;
            session.lastFlushedRev = res.rev ?? res.doc?.rev;
            session.lastFlushedText = flushedText;
            session.approxEncodedBytes = 0;
            ctx.logger.debug(
              `Flushed Y.Doc to Docstore (${lines.length} lines, v${session.currentVersion}, rev${session.lastFlushedRev}): ${key}`,
            );
          })
          .catch(async (err: unknown) => {
            if (
              err instanceof DocNotFoundError ||
              (err as { name?: string })?.name === 'DocNotFoundError'
            ) {
              docWasDeleted = true;
              throw err;
            }
            if (
              err &&
              typeof err === 'object' &&
              'name' in err &&
              err.name === 'DocModifiedError'
            ) {
              ctx.logger.warn(
                `OCC conflict during Y.Doc flush (projectId=${projectId}, docId=${docId}, expectedRev=${session.lastFlushedRev ?? 'none'}). Rebasing against latest Docstore rev.`,
              );
              const fresh = await ctx.docstoreService
                ?.getDoc(projectId, docId)
                .catch(() => null);
              if (!fresh || fresh.deleted) {
                docWasDeleted = true;
                throw err;
              }
              const freshText = Array.isArray(fresh.lines)
                ? fresh.lines.join('\n')
                : '';
              const baseText = session.lastFlushedText ?? '';
              const currentText = session.yText.toString();
              const reconciledText = mergeThreeWayText(
                baseText,
                freshText,
                currentText,
              );

              session.lastFlushedRev = fresh.rev;
              session.currentVersion = fresh.version;
              session.lastFlushedText = freshText;
              session.approxEncodedBytes = 0;

              if (reconciledText !== currentText) {
                const captured = applyTextEditsAndCapture(
                  session.doc,
                  session.yText,
                  currentText,
                  reconciledText,
                  'rest-api',
                );
                if (captured && ctx.server) {
                  const enc = encoding.createEncoder();
                  syncProtocol.writeUpdate(enc, captured);
                  ctx.server
                    .to(PAGES_ROOMS.doc(projectId, docId))
                    .emit(PAGES_EVENTS.YJS_SYNC_UPDATE, {
                      spaceId: projectId,
                      docId,
                      data: Buffer.from(encoding.toUint8Array(enc)),
                    });
                }
              }

              if (reconciledText === freshText) {
                convergedOnConflict = true;
                return;
              }

              const rebasedRes = await ctx.docstoreService!.updateDoc(
                projectId,
                docId,
                {
                  lines: LineArray.textToLines(reconciledText),
                  version: (fresh.version ?? 0) + 1,
                  expectedRev: fresh.rev,
                },
              );
              session.currentVersion =
                rebasedRes.doc?.version ?? (fresh.version ?? 0) + 1;
              session.lastFlushedRev = rebasedRes.rev ?? rebasedRes.doc?.rev;
              session.lastFlushedText = reconciledText;
              convergedOnConflict = true;
              ctx.logger.log(
                `Persisted 3-way merged Y.Doc after OCC conflict (projectId=${projectId}, docId=${docId}, rev=${session.lastFlushedRev})`,
              );
              return;
            }
            throw err;
          }),
      );
    }

    await Promise.all(tasks);

    if (docWasDeleted) {
      await ctx.evictDoc(projectId, docId, { skipFlush: true }).catch(() => {});
      return;
    }

    if (ctx.redis && ctx.redis.isReady()) {
      await saveBinaryToRedisHelper(
        ctx.redis,
        projectId,
        docId,
        session.doc,
        session.lastFlushedRev,
        ctx.redisSnapshotTtlSeconds,
      );
    }

    if (ctx.server) {
      ctx.server
        .to(PAGES_ROOMS.doc(projectId, docId))
        .emit(PAGES_EVENTS.DOC_PERSISTED, {
          spaceId: projectId,
          docId,
          rev: session.lastFlushedRev,
          version: session.currentVersion,
          savedAt: new Date().toISOString(),
        });
    }

    if (convergedOnConflict || session.yText.toString() === flushedText) {
      session.firstUnflushedAt = undefined;
    } else {
      session.firstUnflushedAt = session.firstUnflushedAt ?? Date.now();
      if (!session.flushTimeout) {
        session.flushTimeout = setTimeout(
          () => void ctx.flushDoc(projectId, docId),
          ctx.flushDebounceMs,
        );
        session.flushTimeout.unref?.();
      }
    }
  } catch (err: unknown) {
    const isMissing =
      err instanceof DocNotFoundError ||
      (err as { name?: string })?.name === 'DocNotFoundError';
    if (isMissing) {
      ctx.logger.warn(
        `Stopping flush retries for deleted/missing Y.Doc (projectId=${projectId}, docId=${docId}): ${(err as Error)?.message}`,
      );
      await deleteRedisSnapshotHelper(
        ctx.redis,
        ctx.logger,
        projectId,
        docId,
      ).catch(() => {});
      removeActiveDocSessionHelper(
        ctx.activeDocs,
        ctx.projectDocKeys,
        projectId,
        key,
        session,
      );
      return;
    }
    const isOccConflict =
      Boolean(err) &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'DocModifiedError';
    session.firstUnflushedAt = flushedTimestamp ?? Date.now();
    session.currentVersion = undefined;
    ctx.logger.error(
      `Y.Doc flush failed (projectId=${projectId}, docId=${docId}, reason=${isOccConflict ? 'occ_conflict' : 'db_write_failure'}, expectedRev=${session.lastFlushedRev ?? 'none'}): ${(err as Error)?.message}`,
      (err as Error)?.stack,
    );
    if (!session.flushTimeout) {
      session.flushTimeout = setTimeout(
        () => void ctx.flushDoc(projectId, docId),
        ctx.flushRetryDelayMs,
      );
      session.flushTimeout.unref?.();
    }
  } finally {
    await releaseFlushLockHelper(ctx.redis, ctx.instanceId, projectId, docId);
  }
}

export async function evictDocHelper(
  ctx: YjsPersistenceContext,
  projectId: string,
  docId: string,
  options?: { skipFlush?: boolean },
): Promise<void> {
  const key = yjsDocKey(projectId, docId);
  const inFlight = ctx.inFlightFlushes.get(key);
  if (inFlight) {
    await inFlight.catch(() => {});
  }

  const session = ctx.activeDocs.get(key);
  if (!session) {
    if (options?.skipFlush) {
      await deleteRedisSnapshotHelper(ctx.redis, ctx.logger, projectId, docId);
    }
    return;
  }

  if (options?.skipFlush) {
    await deleteRedisSnapshotHelper(ctx.redis, ctx.logger, projectId, docId);
    const payload: Omit<YjsClusterRelayMessage, 'instanceId'> = {
      type: 'evict',
      projectId,
      docId,
    };
    publishClusterRelayHelper(
      ctx.redis,
      ctx.logger,
      ctx.instanceId,
      payload,
      ctx.pubSub,
    );
  } else {
    try {
      await ctx.flushDoc(projectId, docId);
    } catch (err: unknown) {
      ctx.logger.warn(
        `Flush failed during Y.Doc eviction (projectId=${projectId}, docId=${docId}, error=${(err as Error)?.message})`,
      );
    }
    if (
      session.firstUnflushedAt !== undefined &&
      ctx.redis &&
      ctx.redis.isReady()
    ) {
      await saveBinaryToRedisHelper(
        ctx.redis,
        projectId,
        docId,
        session.doc,
        session.lastFlushedRev,
        ctx.redisSnapshotTtlSeconds,
      ).catch((err: unknown) => {
        ctx.logger.warn(
          `Fallback Redis snapshot failed during Y.Doc eviction (projectId=${projectId}, docId=${docId}, error=${(err as Error)?.message})`,
        );
      });
    }
  }
  removeActiveDocSessionHelper(
    ctx.activeDocs,
    ctx.projectDocKeys,
    projectId,
    key,
    session,
  );
  ctx.logger.debug(`Evicted inactive Y.Doc: ${key}`);
}
