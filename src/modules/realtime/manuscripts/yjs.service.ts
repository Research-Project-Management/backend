/**
 * manuscripts/yjs.service.ts
 * Real-time Binary Yjs CRDT Synchronization Engine (Overleaf/Yjs Parity).
 */

import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { RedisCacheService } from '@/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/domain';
import { YjsUpdateValidator } from './yjs-update-validator';
import { RealtimeConfigService } from '../core/realtime.config';
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
  lastFlushedText?: string;
}

export interface SyncMessageResult {
  reply?: Buffer | null;
  broadcastUpdate?: Buffer | null;
  msgType?: number;
}

@Injectable()
export class YjsService implements OnModuleDestroy {
  private readonly logger = new Logger(YjsService.name);

  // Active in-memory documents: `${projectId}:${docId}` -> ActiveDocSession
  private readonly activeDocs = new Map<string, ActiveDocSession>();

  // Secondary Index: projectId -> Set<docKey> for O(D_project) project-scoped flush
  private readonly projectDocKeys = new Map<string, Set<string>>();

  // Single-Flight Request Coalescing Map
  private readonly inFlightDocInits = new Map<
    string,
    Promise<ActiveDocSession>
  >();

  private readonly FLUSH_DEBOUNCE_MS = 2000;
  private readonly MAX_FLUSH_DELAY_MS = 10000;
  private readonly REDIS_SNAPSHOT_TTL_SECONDS = 7 * 24 * 3600;

  private readonly IDLE_THRESHOLD_MS = 15 * 60 * 1000;
  private readonly MAX_ACTIVE_DOCS = 2000;
  private readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly validator: YjsUpdateValidator;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() validator?: YjsUpdateValidator,
    @Optional() private readonly config?: RealtimeConfigService,
  ) {
    this.validator = validator ?? new YjsUpdateValidator();
    this.startIdleSweeper();
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
      const sorted = [...this.activeDocs.values()]
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

      const targetEvictions = this.activeDocs.size - this.MAX_ACTIVE_DOCS;
      for (let i = 0; i < Math.min(targetEvictions, sorted.length); i++) {
        const s = sorted[i];
        await this.evictDoc(s.projectId, s.docId);
        evictedCount++;
      }
    }

    return evictedCount;
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    const keys = Array.from(this.activeDocs.keys());
    for (const key of keys) {
      const session = this.activeDocs.get(key);
      if (session) {
        await this.evictDoc(session.projectId, session.docId).catch(() => {});
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
  ): Promise<void> {
    if (this.redis && this.redis.isReady()) {
      const binarySnapshot = Y.encodeStateAsUpdate(doc);
      await this.redis.setBuffer(
        this.redisKey(projectId, docId),
        Buffer.from(binarySnapshot),
        this.REDIS_SNAPSHOT_TTL_SECONDS,
      );
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
        if (this.redis && this.redis.isReady()) {
          try {
            const rawBuffer = await this.redis.getBuffer(
              this.redisKey(projectId, docId),
            );
            if (rawBuffer && rawBuffer.length > 0) {
              Y.applyUpdate(doc, rawBuffer, 'redis-init');
              loadedFromRedis = true;
              this.logger.debug(
                `Hydrated Y.Doc from Redis binary cache: ${key} (${rawBuffer.length} bytes)`,
              );
            }
          } catch (err: unknown) {
            this.logger.warn(
              `Failed to read Y.Doc from Redis: ${(err as Error)?.message}`,
            );
          }
        }

        if (!loadedFromRedis && this.docstoreService) {
          try {
            const rawText = await this.docstoreService.getRawDoc(
              projectId,
              docId,
            );
            if (rawText && rawText.length > 0) {
              doc.transact(() => {
                yText.insert(0, rawText);
              }, 'docstore-init');
              this.logger.debug(
                `Hydrated Y.Doc from Docstore baseline (${rawText.length} chars): ${key}`,
              );
            }
          } catch (err: unknown) {
            this.logger.debug(
              `Docstore baseline not found for ${key}, starting with empty doc: ${(err as Error)?.message}`,
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
        };

        doc.on('update', (_update: Uint8Array, origin: unknown) => {
          if (origin === 'redis-init' || origin === 'docstore-init') return;
          if (origin === 'rest-api') {
            session.lastActiveAt = Date.now();
            session.lastFlushedText = session.yText.toString();
            void this.saveBinaryToRedis(projectId, docId, session.doc).catch(
              (err: unknown) => {
                this.logger.warn(
                  `Failed to save rest-api Y.Doc update to Redis for ${key}: ${(err as Error)?.message}`,
                );
              },
            );
            return;
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

    try {
      const dec = decoding.createDecoder(rawUpdate);
      const msgType = decoding.readVarUint(dec);
      if (
        msgType === syncProtocol.messageYjsSyncStep2 ||
        msgType === syncProtocol.messageYjsUpdate
      ) {
        const innerUpdate = decoding.readVarUint8Array(dec);
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
    const current = session.yText.toString();
    if (current === nextText) {
      session.lastFlushedText = nextText;
      return null;
    }

    let prefix = 0;
    const maxPrefix = Math.min(current.length, nextText.length);
    while (prefix < maxPrefix && current[prefix] === nextText[prefix]) prefix++;
    if (
      prefix > 0 &&
      current.charCodeAt(prefix - 1) >= 0xd800 &&
      current.charCodeAt(prefix - 1) <= 0xdbff
    ) {
      prefix--;
    }

    let suffix = 0;
    const maxSuffix = Math.min(current.length, nextText.length) - prefix;
    while (
      suffix < maxSuffix &&
      current[current.length - 1 - suffix] ===
        nextText[nextText.length - 1 - suffix]
    ) {
      suffix++;
    }
    if (
      suffix > 0 &&
      current.charCodeAt(current.length - suffix) >= 0xdc00 &&
      current.charCodeAt(current.length - suffix) <= 0xdfff
    ) {
      suffix--;
    }

    const deleteLen = current.length - prefix - suffix;
    const insertText = nextText.slice(prefix, nextText.length - suffix);

    let captured: Uint8Array | null = null;
    session.currentVersion = undefined;
    const capture = (update: Uint8Array) => {
      captured = captured ? Y.mergeUpdates([captured, update]) : update;
    };
    session.doc.on('update', capture);
    try {
      session.doc.transact(() => {
        if (deleteLen > 0) session.yText.delete(prefix, deleteLen);
        if (insertText.length > 0) session.yText.insert(prefix, insertText);
      }, 'rest-api');
    } finally {
      session.doc.off('update', capture);
    }
    session.lastFlushedText = nextText;
    if (!captured) return null;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, captured);
    return Buffer.from(encoding.toUint8Array(encoder));
  }

  public async applyExternalTextAndSyncRedis(
    projectId: string,
    docId: string,
    nextText: string,
  ): Promise<{ active: boolean; frame: Buffer | null }> {
    if (!this.isActive(projectId, docId)) {
      await this.deleteRedisSnapshot(projectId, docId);
      return { active: false, frame: null };
    }
    const frame = this.replaceTextIfActive(projectId, docId, nextText);
    const session = this.activeDocs.get(this.docKey(projectId, docId));
    if (session) {
      await this.saveBinaryToRedis(projectId, docId, session.doc).catch(
        (err: unknown) => {
          this.logger.warn(
            `Failed to persist external text Y.Doc to Redis for ${projectId}:${docId}: ${(err as Error)?.message}`,
          );
        },
      );
    }
    return { active: true, frame };
  }

  public async flushDoc(projectId: string, docId: string): Promise<void> {
    const key = this.docKey(projectId, docId);
    const session = this.activeDocs.get(key);
    if (!session) return;

    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = undefined;
    }
    const unflushedTimestamp = session.firstUnflushedAt;

    try {
      const tasks: Promise<unknown>[] = [];

      if (this.redis && this.redis.isReady()) {
        tasks.push(this.saveBinaryToRedis(projectId, docId, session.doc));
      }

      if (this.docstoreService) {
        const text = session.yText.toString();
        const lines = LineArrayEngine.textToLines(text);
        if (session.currentVersion === undefined) {
          const currentDoc = await this.docstoreService
            .getDoc(projectId, docId)
            .catch(() => null);
          session.currentVersion = currentDoc?.version ?? 0;
        }
        const nextVersion = (session.currentVersion ?? 0) + 1;

        tasks.push(
          this.docstoreService
            .updateDoc(projectId, docId, { lines, version: nextVersion })
            .then((res) => {
              session.currentVersion = res.doc?.version ?? nextVersion;
              session.lastFlushedText = text;
              this.logger.debug(
                `Flushed Y.Doc to Docstore (${lines.length} lines, v${session.currentVersion}): ${key}`,
              );
            }),
        );
      }

      await Promise.all(tasks);
      session.firstUnflushedAt = undefined;
    } catch (err: unknown) {
      session.firstUnflushedAt = unflushedTimestamp ?? Date.now();
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

  public async evictDoc(projectId: string, docId: string): Promise<void> {
    const key = this.docKey(projectId, docId);
    const session = this.activeDocs.get(key);
    if (!session) return;

    try {
      await this.flushDoc(projectId, docId);
    } catch {
      // Ignore flush errors on forced eviction
    }
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = undefined;
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
