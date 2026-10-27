/**
 * manuscripts/yjs.service.ts
 * Real-time Binary Yjs CRDT Synchronization Engine (Overleaf/Yjs Parity).
 */

import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { RedisCacheService } from '@/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { LineArrayEngine, DocNotFoundError } from '@/modules/manuscripts/docstore/domain';
import { YjsUpdateValidator } from './yjs-update-validator';
import {
  YjsCursorDiffEngine,
  type YjsCursorPreservingEdit,
} from './yjs-cursor-diff.engine';
import { RealtimeConfigService } from '../core/realtime.config';
import { REALTIME_EVENTS } from '../core/realtime.constant';
import { RealtimeException } from '../core/ws-errors';

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

@Injectable()
export class YjsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YjsService.name);
  public readonly instanceId = randomUUID();
  private static readonly CLUSTER_CHANNEL = 'manuscript:crdt:cluster';
  private pubSubSubscriber: any = null;

  // Active in-memory documents: `${projectId}:${docId}` -> ActiveDocSession
  private readonly activeDocs = new Map<string, ActiveDocSession>();

  // Secondary Index: projectId -> Set<docKey> for O(D_project) project-scoped flush
  private readonly projectDocKeys = new Map<string, Set<string>>();

  // Single-Flight Request Coalescing Map
  private readonly inFlightDocInits = new Map<
    string,
    Promise<ActiveDocSession>
  >();
  private readonly inFlightFlushes = new Map<string, Promise<void>>();

  private readonly FLUSH_DEBOUNCE_MS = 2000;
  private readonly MAX_FLUSH_DELAY_MS = 10000;
  private readonly REDIS_SNAPSHOT_TTL_SECONDS = 7 * 24 * 3600;

  private readonly IDLE_THRESHOLD_MS = 15 * 60 * 1000;
  private readonly MAX_ACTIVE_DOCS = 2000;
  private readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly validator: YjsUpdateValidator;
  private server: Server | null = null;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() validator?: YjsUpdateValidator,
    @Optional() private readonly config?: RealtimeConfigService,
  ) {
    this.validator = validator ?? new YjsUpdateValidator();
    this.startIdleSweeper();
  }

  public setServer(server: Server): void {
    this.server = server;
  }

  private startIdleSweeper(): void {
    this.sweepTimer = setInterval(() => {
      this.sweepIdleDocs().catch((err) => {
        this.logger.warn(`Error during Y.Doc idle sweep: ${err?.message}`);
      });
    }, this.SWEEP_INTERVAL_MS);
    if (this.sweepTimer && typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  public async sweepIdleDocs(): Promise<number> {
    const now = Date.now();
    let evictedCount = 0;

    for (const [, session] of this.activeDocs.entries()) {
      if (now - session.lastActiveAt > this.IDLE_THRESHOLD_MS) {
        await this.evictDoc(session.projectId, session.docId);
        evictedCount++;
      }
    }

    if (evictedCount > 0) {
      this.logger.log(
        `Garbage collected ${evictedCount} idle Y.Doc in-memory session(s)`,
      );
    }

    // Capacity overflow protection: evict least recently active docs if exceeding MAX_ACTIVE_DOCS
    if (this.activeDocs.size > this.MAX_ACTIVE_DOCS) {
      const sorted = [...this.activeDocs.values()].sort(
        (a, b) => a.lastActiveAt - b.lastActiveAt,
      );

      const targetEvictions = this.activeDocs.size - this.MAX_ACTIVE_DOCS;
      for (let i = 0; i < Math.min(targetEvictions, sorted.length); i++) {
        const s = sorted[i];
        await this.evictDoc(s.projectId, s.docId);
        evictedCount++;
      }
    }

    return evictedCount;
  }

  public async onModuleInit(): Promise<void> {
    if (!this.redis || !this.redis.isReady()) return;
    const baseClient = this.redis.getClient?.();
    if (!baseClient || typeof baseClient.duplicate !== 'function') return;

    try {
      this.pubSubSubscriber = baseClient.duplicate();
      this.pubSubSubscriber.on('error', (err: Error) => {
        this.logger.warn(`Yjs Redis subscriber error: ${err.message}`);
      });
      this.pubSubSubscriber.on('message', (channel: string, raw: string) => {
        if (channel !== YjsService.CLUSTER_CHANNEL) return;
        this.handleClusterRelayRaw(raw);
      });
      if (typeof this.pubSubSubscriber.subscribe === 'function') {
        await this.pubSubSubscriber.subscribe(YjsService.CLUSTER_CHANNEL);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to initialize Yjs Redis pub/sub relay: ${(err as Error)?.message}`,
      );
    }
  }

  public handleClusterRelayRaw(raw: string): void {
    try {
      const msg = JSON.parse(raw) as YjsClusterRelayMessage;
      this.handleClusterRelayMessage(msg);
    } catch (err: unknown) {
      this.logger.warn(
        `Invalid Yjs cluster relay payload: ${(err as Error)?.message}`,
      );
    }
  }

  public handleClusterRelayMessage(msg: YjsClusterRelayMessage): void {
    if (!msg || msg.instanceId === this.instanceId) return;
    const key = this.docKey(msg.projectId, msg.docId);
    const session = this.activeDocs.get(key);
    if (!session) return;

    if (msg.type === 'evict') {
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = undefined;
      }
      this.activeDocs.delete(key);
      this.projectDocKeys.get(msg.projectId)?.delete(key);
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
        if (this.server) {
          this.server
            .to(`doc:${msg.projectId}:${msg.docId}`)
            .emit(REALTIME_EVENTS.YJS_SYNC_UPDATE, {
              projectId: msg.projectId,
              docId: msg.docId,
              data: frame,
            });
        }
      }
      if (this.redis && this.redis.isReady()) {
        void this.saveBinaryToRedis(
          msg.projectId,
          msg.docId,
          session.doc,
          session.lastFlushedRev,
        ).catch((err: unknown) => {
          this.logger.warn(
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

  private publishClusterRelay(
    payload: Omit<YjsClusterRelayMessage, 'instanceId'>,
  ): void {
    if (!this.redis || !this.redis.isReady()) return;
    const client = this.redis.getClient?.();
    if (!client || typeof client.publish !== 'function') return;

    const fullMsg: YjsClusterRelayMessage = {
      instanceId: this.instanceId,
      ...payload,
    };
    Promise.resolve(
      client.publish(YjsService.CLUSTER_CHANNEL, JSON.stringify(fullMsg)),
    ).catch((err: unknown) => {
      this.logger.warn(
        `Failed to publish Yjs cluster relay message: ${(err as Error)?.message}`,
      );
    });
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    if (this.pubSubSubscriber) {
      try {
        await this.pubSubSubscriber.quit?.();
      } catch {
        this.pubSubSubscriber.disconnect?.();
      }
      this.pubSubSubscriber = null;
    }

    const keys = Array.from(this.activeDocs.keys());
    for (const key of keys) {
      const session = this.activeDocs.get(key);
      if (session) {
        await this.evictDoc(session.projectId, session.docId).catch((err) =>
          this.logger.error(
            `Failed to flush/evict ${key} during shutdown; unsaved edits may be lost: ${(err as Error)?.message}`,
          ),
        );
      }
    }
    this.activeDocs.clear();
    this.projectDocKeys.clear();
    this.logger.log(
      'Gracefully flushed and destroyed all active Y.Doc sessions',
    );
  }

  private docKey(projectId: string, docId: string): string {
    return `${projectId}:${docId}`;
  }

  private redisKey(projectId: string, docId: string): string {
    return `manuscript:crdt:bin:${projectId}:${docId}`;
  }

  private redisMetaKey(projectId: string, docId: string): string {
    return `manuscript:crdt:meta:${projectId}:${docId}`;
  }

  private redisFlushLockKey(projectId: string, docId: string): string {
    return `lock:yjs:flush:${projectId}:${docId}`;
  }

  public getRedisBinaryKey(projectId: string, docId: string): string {
    return this.redisKey(projectId, docId);
  }

  public async deleteRedisSnapshot(
    projectId: string,
    docId: string,
  ): Promise<void> {
    if (this.redis && this.redis.isReady()) {
      try {
        await this.redis.del(this.redisKey(projectId, docId));
        await this.redis.del(this.redisMetaKey(projectId, docId));
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to delete Redis CRDT snapshot for ${projectId}:${docId}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  private async saveBinaryToRedis(
    projectId: string,
    docId: string,
    doc: Y.Doc,
    rev?: number,
  ): Promise<void> {
    if (this.redis && this.redis.isReady()) {
      const binarySnapshot = Y.encodeStateAsUpdate(doc);
      await this.redis.setBuffer(
        this.redisKey(projectId, docId),
        Buffer.from(binarySnapshot),
        this.REDIS_SNAPSHOT_TTL_SECONDS,
      );
      if (rev !== undefined && typeof this.redis.set === 'function') {
        await this.redis
          .set(
            this.redisMetaKey(projectId, docId),
            { rev, updatedAt: Date.now() },
            this.REDIS_SNAPSHOT_TTL_SECONDS,
          )
          .catch(() => {});
      }
    }
  }

  public async getOrCreateDoc(
    projectId: string,
    docId: string,
  ): Promise<ActiveDocSession> {
    const key = this.docKey(projectId, docId);
    const existing = this.activeDocs.get(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const inFlight = this.inFlightDocInits.get(key);
    if (inFlight) {
      return inFlight;
    }

    const initPromise = (async () => {
      try {
        const doc = new Y.Doc();
        const yText = doc.getText('latex');

        let loadedFromRedis = false;
        let baselineDocRecord: { lines?: string[]; rev?: number; version?: number } | null = null;
        if (this.redis && this.redis.isReady()) {
          try {
            const rawBuffer = await this.redis.getBuffer(
              this.redisKey(projectId, docId),
            );
            if (rawBuffer && rawBuffer.length > 0) {
              let redisIsStale = false;
              if (
                this.docstoreService &&
                typeof this.redis.get === 'function' &&
                typeof this.docstoreService.getDoc === 'function'
              ) {
                try {
                  const meta = await this.redis.get<{ rev?: number }>(
                    this.redisMetaKey(projectId, docId),
                  );
                  if (meta && typeof meta.rev === 'number') {
                    baselineDocRecord = await this.docstoreService
                      .getDoc(projectId, docId)
                      .catch(() => null);
                    if (
                      baselineDocRecord?.rev !== undefined &&
                      baselineDocRecord.rev > meta.rev
                    ) {
                      redisIsStale = true;
                      this.logger.warn(
                        `Discarding stale Redis Y.Doc snapshot for ${key} (redis rev=${meta.rev} < docstore rev=${baselineDocRecord.rev})`,
                      );
                      await this.deleteRedisSnapshot(projectId, docId);
                    }
                  }
                } catch {
                  // Ignore metadata check errors
                }
              }

              if (!redisIsStale) {
                Y.applyUpdate(doc, rawBuffer, 'redis-init');
                loadedFromRedis = true;
                this.logger.debug(
                  `Hydrated Y.Doc from Redis binary cache: ${key} (${rawBuffer.length} bytes)`,
                );
              }
            }
          } catch (err: unknown) {
            this.logger.warn(
              `Failed to read Y.Doc from Redis: ${(err as Error)?.message}`,
            );
          }
        }

        if (!loadedFromRedis && this.docstoreService) {
          try {
            let rawText: string | null = null;
            if (baselineDocRecord && Array.isArray(baselineDocRecord.lines)) {
              rawText = baselineDocRecord.lines.join('\n');
            } else if (
              typeof (this.docstoreService as any).getRawDoc === 'function'
            ) {
              rawText = await (this.docstoreService as any).getRawDoc(
                projectId,
                docId,
              );
            } else if (typeof this.docstoreService.getDoc === 'function') {
              const res = await this.docstoreService.getDoc(projectId, docId);
              baselineDocRecord = res;
              rawText = Array.isArray(res?.lines) ? res.lines.join('\n') : '';
            }
            if (rawText && rawText.length > 0) {
              doc.transact(() => {
                yText.insert(0, rawText);
              }, 'docstore-init');
              this.logger.debug(
                `Hydrated Y.Doc from Docstore baseline (${rawText.length} chars): ${key}`,
              );
            }
          } catch (err: unknown) {
            const isNotFound =
              err instanceof DocNotFoundError ||
              (err as { name?: string })?.name === 'DocNotFoundError' ||
              (err as { message?: string })?.message?.includes('not found');
            if (isNotFound) {
              this.logger.debug(
                `Docstore baseline not found for ${key}, starting with empty doc: ${(err as Error)?.message}`,
              );
            } else {
              this.logger.error(
                `Critical error hydrating Docstore baseline for ${key}: ${(err as Error)?.message}`,
                (err as Error)?.stack,
              );
              throw err;
            }
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
            this.publishClusterRelay({
              type: 'yjs-update',
              projectId,
              docId,
              updateBase64: Buffer.from(update).toString('base64'),
            });
          }
          this.handleDocUpdated(projectId, docId, session);
        });

        this.activeDocs.set(key, session);
        let projSet = this.projectDocKeys.get(projectId);
        if (!projSet) {
          projSet = new Set();
          this.projectDocKeys.set(projectId, projSet);
        }
        projSet.add(key);
        return session;
      } finally {
        this.inFlightDocInits.delete(key);
      }
    })();

    this.inFlightDocInits.set(key, initPromise);
    return initPromise;
  }

  private assertPostApplySizeBeforeMutation(
    doc: Y.Doc,
    applyAction: (targetDoc: Y.Doc) => void,
  ): void {
    const maxDocSize = this.config?.getMaxDocumentSizeBytes() ?? 20 * 1024 * 1024;
    let approxChars = 0;
    for (const item of doc.share.values()) {
      const anyItem = item as unknown as { length?: number };
      if (typeof anyItem?.length === 'number') {
        approxChars += anyItem.length;
      }
    }
    if (
      maxDocSize <= 1024 ||
      approxChars * 4 > maxDocSize - 64 * 1024
    ) {
      const tempDoc = new Y.Doc();
      tempDoc.getText('latex');
      Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(doc));
      applyAction(tempDoc);
      this.validator.validatePostApplySize(tempDoc, maxDocSize);
      tempDoc.destroy();
    }
  }

  public async handleSyncMessage(
    projectId: string,
    docId: string,
    data: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<SyncMessageResult> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawBytes = this.normalizeToUint8Array(data);

    if (!rawBytes || rawBytes.length === 0) {
      return { reply: null, broadcastUpdate: null };
    }

    try {
      const peekDec = decoding.createDecoder(rawBytes);
      const peekMsgType = decoding.readVarUint(peekDec);
      if (
        peekMsgType === syncProtocol.messageYjsUpdate ||
        peekMsgType === syncProtocol.messageYjsSyncStep2
      ) {
        this.validator.validatePreApplySize(
          session.doc,
          rawBytes.byteLength,
          this.config?.getMaxDocumentSizeBytes(),
        );
        this.assertPostApplySizeBeforeMutation(session.doc, (tempDoc) => {
          const tempDec = decoding.createDecoder(rawBytes);
          const tempEnc = encoding.createEncoder();
          syncProtocol.readSyncMessage(tempDec, tempEnc, tempDoc, origin);
        });
      }

      const decoder = decoding.createDecoder(rawBytes);
      const encoder = encoding.createEncoder();

      const msgType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        session.doc,
        origin,
      );

      let reply: Buffer | null = null;
      if (encoding.length(encoder) > 0) {
        reply = Buffer.from(encoding.toUint8Array(encoder));
      }

      let broadcastUpdate: Buffer | null = null;
      if (
        msgType === syncProtocol.messageYjsUpdate ||
        msgType === syncProtocol.messageYjsSyncStep2
      ) {
        this.validator.validatePostApplySize(
          session.doc,
          this.config?.getMaxDocumentSizeBytes(),
        );
        const updateEncoder = encoding.createEncoder();
        const rawUpdate = this.extractRawUpdateIfPresent(rawBytes, msgType);
        if (rawUpdate) {
          syncProtocol.writeUpdate(updateEncoder, rawUpdate);
          broadcastUpdate = Buffer.from(encoding.toUint8Array(updateEncoder));
        }
      }

      return {
        reply,
        broadcastUpdate,
        msgType,
      };
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      this.logger.warn(
        `Failed to decode or process sync message for ${projectId}:${docId}: ${(err as Error)?.message}`,
      );
      return { reply: null, broadcastUpdate: null };
    }
  }

  public async handleSyncStep1(
    projectId: string,
    docId: string,
    stateVector: Uint8Array | Buffer | number[] | string,
  ): Promise<Buffer> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawVector = this.normalizeToUint8Array(stateVector);

    try {
      let stateVectorToUse = rawVector;
      try {
        const dec = decoding.createDecoder(rawVector);
        const msgType = decoding.readVarUint(dec);
        if (msgType === syncProtocol.messageYjsSyncStep1) {
          stateVectorToUse = decoding.readVarUint8Array(dec);
        }
      } catch {
        // Direct raw state vector
      }

      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep2(encoder, session.doc, stateVectorToUse);
      syncProtocol.writeSyncStep1(encoder, session.doc);
      return Buffer.from(encoding.toUint8Array(encoder));
    } catch (err: unknown) {
      this.logger.warn(`handleSyncStep1 error: ${(err as Error)?.message}`);
      return Buffer.alloc(0);
    }
  }

  public async handleSyncStep2(
    projectId: string,
    docId: string,
    update: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<void> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawUpdate = this.normalizeToUint8Array(update);
    if (!rawUpdate || rawUpdate.length === 0) return;

    this.validator.validatePreApplySize(
      session.doc,
      rawUpdate.byteLength,
      this.config?.getMaxDocumentSizeBytes(),
    );

    try {
      const dec = decoding.createDecoder(rawUpdate);
      const msgType = decoding.readVarUint(dec);
      if (
        msgType === syncProtocol.messageYjsSyncStep2 ||
        msgType === syncProtocol.messageYjsUpdate
      ) {
        const innerUpdate = decoding.readVarUint8Array(dec);
        this.assertPostApplySizeBeforeMutation(session.doc, (tempDoc) => {
          Y.applyUpdate(tempDoc, innerUpdate, origin);
        });
        Y.applyUpdate(session.doc, innerUpdate, origin);
        this.validator.validatePostApplySize(
          session.doc,
          this.config?.getMaxDocumentSizeBytes(),
        );
        return;
      }
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      // Direct apply fallback
    }

    try {
      this.assertPostApplySizeBeforeMutation(session.doc, (tempDoc) => {
        Y.applyUpdate(tempDoc, rawUpdate, origin);
      });
      Y.applyUpdate(session.doc, rawUpdate, origin);
      this.validator.validatePostApplySize(
        session.doc,
        this.config?.getMaxDocumentSizeBytes(),
      );
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      this.logger.warn(`handleSyncStep2 error: ${(err as Error)?.message}`);
    }
  }

  public async handleSyncUpdate(
    projectId: string,
    docId: string,
    update: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<Buffer> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawBytes = this.normalizeToUint8Array(update);
    if (!rawBytes || rawBytes.length === 0) return Buffer.alloc(0);

    this.validator.validatePreApplySize(
      session.doc,
      rawBytes.byteLength,
      this.config?.getMaxDocumentSizeBytes(),
    );

    try {
      let updateToApply: Uint8Array = rawBytes;
      try {
        const dec = decoding.createDecoder(rawBytes);
        const msgType = decoding.readVarUint(dec);
        if (
          msgType === syncProtocol.messageYjsUpdate ||
          msgType === syncProtocol.messageYjsSyncStep2
        ) {
          const candidate = decoding.readVarUint8Array(dec);
          if (dec.pos === rawBytes.length) {
            updateToApply = candidate;
          }
        }
      } catch {
        // Direct update bytes
      }

      this.assertPostApplySizeBeforeMutation(session.doc, (tempDoc) => {
        try {
          Y.applyUpdate(tempDoc, updateToApply, origin);
        } catch (applyErr) {
          if (updateToApply !== rawBytes) {
            Y.applyUpdate(tempDoc, rawBytes, origin);
          } else {
            throw applyErr;
          }
        }
      });

      try {
        Y.applyUpdate(session.doc, updateToApply, origin);
      } catch (applyErr) {
        if (updateToApply !== rawBytes) {
          Y.applyUpdate(session.doc, rawBytes, origin);
          updateToApply = rawBytes;
        } else {
          throw applyErr;
        }
      }

      this.validator.validatePostApplySize(
        session.doc,
        this.config?.getMaxDocumentSizeBytes(),
      );

      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, updateToApply);
      return Buffer.from(encoding.toUint8Array(encoder));
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      this.logger.warn(`handleSyncUpdate error: ${(err as Error)?.message}`);
      return Buffer.alloc(0);
    }
  }

  public async getText(projectId: string, docId: string): Promise<string> {
    const session = await this.getOrCreateDoc(projectId, docId);
    return session.yText.toString();
  }

  public isActive(projectId: string, docId: string): boolean {
    return this.activeDocs.has(this.docKey(projectId, docId));
  }

  public replaceTextIfActive(
    projectId: string,
    docId: string,
    nextText: string,
  ): Buffer | null {
    const session = this.activeDocs.get(this.docKey(projectId, docId));
    if (!session) return null;
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = undefined;
    }
    session.firstUnflushedAt = undefined;
    session.lastFlushedRev = undefined;

    const current = session.yText.toString();
    if (current === nextText) {
      session.lastFlushedText = nextText;
      return null;
    }

    let captured: Uint8Array | null = null;
    session.currentVersion = undefined;
    const capture = (update: Uint8Array) => {
      captured = captured ? Y.mergeUpdates([captured, update]) : update;
    };
    session.doc.on('update', capture);
    try {
      YjsCursorDiffEngine.applyEditsToYText(
        session.doc,
        session.yText,
        current,
        nextText,
        'rest-api',
      );
    } finally {
      session.doc.off('update', capture);
    }
    session.lastFlushedText = nextText;
    if (!captured) return null;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, captured);
    return Buffer.from(encoding.toUint8Array(encoder));
  }

  /**
   * Computes minimal cursor-preserving character edits between `current` and `nextText`.
   * Delegates to pure domain engine `YjsCursorDiffEngine`.
   */
  public computeCursorPreservingEdits(
    current: string,
    nextText: string,
  ): YjsCursorPreservingEdit[] {
    return YjsCursorDiffEngine.computeCursorPreservingEdits(current, nextText);
  }

  public async applyExternalTextAndSyncRedis(
    projectId: string,
    docId: string,
    nextText: string,
  ): Promise<{ active: boolean; frame: Buffer | null }> {
    const key = this.docKey(projectId, docId);
    const inFlight = this.inFlightFlushes.get(key);
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    this.publishClusterRelay({
      type: 'external-text',
      projectId,
      docId,
      text: nextText,
    });
    if (!this.isActive(projectId, docId)) {
      await this.deleteRedisSnapshot(projectId, docId);
      return { active: false, frame: null };
    }
    const frame = this.replaceTextIfActive(projectId, docId, nextText);
    const session = this.activeDocs.get(key);
    if (session) {
      if (this.docstoreService) {
        const freshDoc = await this.docstoreService
          .getDoc(projectId, docId)
          .catch(() => null);
        if (freshDoc) {
          session.lastFlushedRev = freshDoc.rev;
          session.currentVersion = freshDoc.version;
        }
      }
      await this.saveBinaryToRedis(
        projectId,
        docId,
        session.doc,
        session.lastFlushedRev,
      ).catch((err: unknown) => {
        this.logger.warn(
          `Failed to persist external text Y.Doc to Redis for ${projectId}:${docId}: ${(err as Error)?.message}`,
        );
      });
    }
    return { active: true, frame };
  }

  public async flushDoc(projectId: string, docId: string): Promise<void> {
    const key = this.docKey(projectId, docId);
    const existingFlush = this.inFlightFlushes.get(key);
    if (existingFlush) {
      await existingFlush;
      const postSession = this.activeDocs.get(key);
      if (
        postSession &&
        (postSession.firstUnflushedAt !== undefined ||
          postSession.yText.toString() !== postSession.lastFlushedText)
      ) {
        return this.flushDoc(projectId, docId);
      }
      return;
    }

    const session = this.activeDocs.get(key);
    if (!session) return;

    const flushPromise = this.executeFlushDoc(projectId, docId, key, session);
    this.inFlightFlushes.set(key, flushPromise);
    try {
      await flushPromise;
    } finally {
      if (this.inFlightFlushes.get(key) === flushPromise) {
        this.inFlightFlushes.delete(key);
      }
    }
  }

  private async acquireFlushLock(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    if (!this.redis || !this.redis.isReady()) return true;
    const client = this.redis.getClient?.();
    if (!client || typeof client.set !== 'function') return true;
    try {
      const lockKey = this.redisFlushLockKey(projectId, docId);
      const res = await client.set(lockKey, this.instanceId, 'PX', 10000, 'NX');
      return res === 'OK';
    } catch {
      return true;
    }
  }

  private static readonly RELEASE_FLUSH_LOCK_LUA = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  private async releaseFlushLock(
    projectId: string,
    docId: string,
  ): Promise<void> {
    if (!this.redis || !this.redis.isReady()) return;
    const client = this.redis.getClient?.() as
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
      const lockKey = this.redisFlushLockKey(projectId, docId);
      if (typeof client.eval === 'function') {
        await client.eval(
          YjsService.RELEASE_FLUSH_LOCK_LUA,
          1,
          lockKey,
          this.instanceId,
        );
        return;
      }
      const owner = await client.get?.(lockKey);
      if (!owner || owner === this.instanceId) {
        await client.del?.(lockKey);
      }
    } catch {
      // Ignore lock release error
    }
  }

  private async executeFlushDoc(
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

    const hasLock = await this.acquireFlushLock(projectId, docId);
    if (!hasLock) {
      if (!session.flushTimeout) {
        session.flushTimeout = setTimeout(
          () => void this.flushDoc(projectId, docId),
          this.FLUSH_DEBOUNCE_MS,
        );
      }
      return;
    }

    try {
      const tasks: Promise<unknown>[] = [];

      if (this.docstoreService) {
        const lines = LineArrayEngine.textToLines(flushedText);
        if (
          session.currentVersion === undefined ||
          session.lastFlushedRev === undefined
        ) {
          const currentDoc = await this.docstoreService
            .getDoc(projectId, docId)
            .catch(() => null);
          session.currentVersion = currentDoc?.version ?? 0;
          session.lastFlushedRev = currentDoc?.rev;
        }
        const nextVersion = (session.currentVersion ?? 0) + 1;

        tasks.push(
          this.docstoreService
            .updateDoc(projectId, docId, {
              lines,
              version: nextVersion,
              expectedRev: session.lastFlushedRev,
            })
            .then((res) => {
              session.currentVersion = res.doc?.version ?? nextVersion;
              session.lastFlushedRev = res.rev ?? res.doc?.rev;
              session.lastFlushedText = flushedText;
              this.logger.debug(
                `Flushed Y.Doc to Docstore (${lines.length} lines, v${session.currentVersion}, rev${session.lastFlushedRev}): ${key}`,
              );
            })
            .catch(async (err: unknown) => {
              if (
                err &&
                typeof err === 'object' &&
                'name' in err &&
                err.name === 'DocModifiedError'
              ) {
                this.logger.warn(
                  `OCC conflict during Y.Doc flush for ${key}. Re-fetching base rev.`,
                );
                const fresh = await this.docstoreService
                  ?.getDoc(projectId, docId)
                  .catch(() => null);
                if (fresh) {
                  session.lastFlushedRev = fresh.rev;
                  session.currentVersion = fresh.version;
                }
              }
              throw err;
            }),
        );
      }

      await Promise.all(tasks);

      if (this.redis && this.redis.isReady()) {
        await this.saveBinaryToRedis(
          projectId,
          docId,
          session.doc,
          session.lastFlushedRev,
        );
      }

      if (session.yText.toString() === flushedText) {
        session.firstUnflushedAt = undefined;
      } else {
        session.firstUnflushedAt = session.firstUnflushedAt ?? Date.now();
        if (!session.flushTimeout) {
          session.flushTimeout = setTimeout(
            () => void this.flushDoc(projectId, docId),
            this.FLUSH_DEBOUNCE_MS,
          );
        }
      }
    } catch (err: unknown) {
      session.firstUnflushedAt = flushedTimestamp ?? Date.now();
      session.currentVersion = undefined;
      this.logger.error(
        `Error flushing Y.Doc ${key}: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      if (!session.flushTimeout) {
        session.flushTimeout = setTimeout(
          () => void this.flushDoc(projectId, docId),
          1500,
        );
      }
    } finally {
      await this.releaseFlushLock(projectId, docId);
    }
  }

  public async flushProjectDocs(projectId: string): Promise<string[]> {
    const docKeys = this.projectDocKeys.get(projectId);
    if (!docKeys || docKeys.size === 0) return [];

    const flushedDocIds: string[] = [];
    const promises: Promise<void>[] = [];
    for (const key of docKeys) {
      const session = this.activeDocs.get(key);
      if (session) {
        flushedDocIds.push(session.docId);
        promises.push(this.flushDoc(session.projectId, session.docId));
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
      this.logger.log(
        `Pre-compile flush barrier completed for ${promises.length} active doc(s) in project ${projectId}`,
      );
    }
    return flushedDocIds;
  }

  public async flushProject(projectId: string): Promise<number> {
    const flushed = await this.flushProjectDocs(projectId);
    return flushed.length;
  }

  public async evictDoc(
    projectId: string,
    docId: string,
    options?: { skipFlush?: boolean },
  ): Promise<void> {
    const key = this.docKey(projectId, docId);
    const inFlight = this.inFlightFlushes.get(key);
    if (inFlight) {
      await inFlight.catch(() => {});
    }

    const session = this.activeDocs.get(key);
    if (!session) {
      if (options?.skipFlush) {
        await this.deleteRedisSnapshot(projectId, docId);
      }
      return;
    }

    if (options?.skipFlush) {
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = undefined;
      }
      await this.deleteRedisSnapshot(projectId, docId);
      this.publishClusterRelay({
        type: 'evict',
        projectId,
        docId,
      });
    } else {
      try {
        await this.flushDoc(projectId, docId);
      } catch {
        // Ignore flush errors on forced eviction
      }
      // Best-effort Redis snapshot save in case distributed lock was busy during flushDoc
      if (
        session.firstUnflushedAt !== undefined &&
        this.redis &&
        this.redis.isReady()
      ) {
        await this.saveBinaryToRedis(
          projectId,
          docId,
          session.doc,
          session.lastFlushedRev,
        ).catch(() => {});
      }
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = undefined;
      }
    }
    this.activeDocs.delete(key);
    const projSet = this.projectDocKeys.get(projectId);
    if (projSet) {
      projSet.delete(key);
      if (projSet.size === 0) {
        this.projectDocKeys.delete(projectId);
      }
    }
    session.doc.destroy();
    this.logger.debug(`Evicted inactive Y.Doc: ${key}`);
  }

  private handleDocUpdated(
    projectId: string,
    docId: string,
    session: ActiveDocSession,
  ): void {
    const now = Date.now();
    session.lastActiveAt = now;
    if (!session.firstUnflushedAt) {
      session.firstUnflushedAt = now;
    }

    const elapsedSinceFirstUnflushed = now - session.firstUnflushedAt;

    if (elapsedSinceFirstUnflushed >= this.MAX_FLUSH_DELAY_MS) {
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = undefined;
      }
      this.flushDoc(projectId, docId).catch((err: unknown) => {
        this.logger.warn(
          `Bounded flush failed for ${projectId}:${docId}: ${(err as Error)?.message}`,
        );
      });
      return;
    }

    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
    }

    session.flushTimeout = setTimeout(() => {
      this.flushDoc(projectId, docId).catch((err: unknown) => {
        this.logger.warn(
          `Debounced flush failed for ${projectId}:${docId}: ${(err as Error)?.message}`,
        );
      });
    }, this.FLUSH_DEBOUNCE_MS);
  }

  private normalizeToUint8Array(data: unknown): Uint8Array {
    return this.validator.validateSyncPayload(
      data,
      this.config?.getMaxYjsUpdateSizeBytes() ?? 512 * 1024,
    );
  }

  private extractRawUpdateIfPresent(
    rawBytes: Uint8Array,
    msgType: number,
  ): Uint8Array | null {
    try {
      const dec = decoding.createDecoder(rawBytes);
      const readType = decoding.readVarUint(dec);
      if (readType === msgType) {
        return decoding.readVarUint8Array(dec);
      }
    } catch {
      // Fallback
    }
    return null;
  }
}
