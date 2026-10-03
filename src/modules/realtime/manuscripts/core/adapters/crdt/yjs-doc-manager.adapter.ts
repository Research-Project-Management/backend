/**
 * realtime/manuscripts/core/adapters/crdt/yjs-doc-manager.adapter.ts
 *
 * Real-time Binary Yjs CRDT Synchronization Engine (Overleaf/Yjs Parity).
 * Manages in-memory Y.Doc state vectors, applies binary sync steps,
 * caches binary buffers in Redis, and debounces flush to Docstore.
 */

import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { RedisCacheService } from '@/core/cache/redis.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/core/adapters/engine/line-array.engine';

export interface ActiveDocSession {
  doc: Y.Doc;
  yText: Y.Text;
  projectId: string;
  docId: string;
  flushTimeout?: NodeJS.Timeout;
  lastActiveAt: number;
}

export interface SyncMessageResult {
  reply?: Buffer | null;
  broadcastUpdate?: Buffer | null;
  msgType?: number;
}

@Injectable()
export class YjsDocManagerAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(YjsDocManagerAdapter.name);

  // Active in-memory documents: `${projectId}:${docId}` -> ActiveDocSession
  private readonly activeDocs = new Map<string, ActiveDocSession>();

  // Debounce delay before flushing Y.Doc text to persistent Docstore (ms)
  private readonly FLUSH_DEBOUNCE_MS = 2000;
  // TTL for Redis binary CRDT snapshot (7 days)
  private readonly REDIS_SNAPSHOT_TTL_SECONDS = 7 * 24 * 3600;

  // Maximum idle duration before evicting Y.Doc from memory (15 minutes)
  private readonly IDLE_THRESHOLD_MS = 15 * 60 * 1000;
  // Background garbage collection sweep interval (5 minutes)
  private readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly docstoreService?: DocstoreService,
  ) {
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

    for (const [key, session] of this.activeDocs.entries()) {
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

  /**
   * Retrieves or initializes an active Y.Doc instance for collaborative editing.
   */
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

    const doc = new Y.Doc();
    const yText = doc.getText('latex');

    // 1. Try to load cached binary state vector from Redis
    let loadedFromRedis = false;
    if (this.redis && this.redis.isReady()) {
      try {
        const client = this.redis.getClient();
        if (client) {
          const snapshotBase64 = await client.get(
            this.redisKey(projectId, docId),
          );
          if (snapshotBase64) {
            const buffer = Buffer.from(snapshotBase64, 'base64');
            Y.applyUpdate(doc, buffer, 'redis-init');
            loadedFromRedis = true;
            this.logger.debug(`Hydrated Y.Doc from Redis cache: ${key}`);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to read Y.Doc from Redis: ${err?.message}`);
      }
    }

    // 2. If not in Redis, load baseline raw text from Docstore
    if (!loadedFromRedis && this.docstoreService) {
      try {
        const rawText = await this.docstoreService.getRawDoc(projectId, docId);
        if (rawText && rawText.length > 0) {
          doc.transact(() => {
            yText.insert(0, rawText);
          }, 'docstore-init');
          this.logger.debug(
            `Hydrated Y.Doc from Docstore baseline (${rawText.length} chars): ${key}`,
          );
        }
      } catch (err: any) {
        this.logger.debug(
          `Docstore baseline not found for ${key}, starting with empty doc: ${err?.message}`,
        );
      }
    }

    const session: ActiveDocSession = {
      doc,
      yText,
      projectId,
      docId,
      lastActiveAt: Date.now(),
    };

    // 3. Setup update listener to cache in Redis and schedule flush
    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === 'redis-init' || origin === 'docstore-init') return;
      this.handleDocUpdated(projectId, docId, session);
    });

    this.activeDocs.set(key, session);
    return session;
  }

  /**
   * Universal y-protocols/sync message processor:
   * Handles SyncStep1, SyncStep2, and Update binary frames.
   */
  public async handleSyncMessage(
    projectId: string,
    docId: string,
    data: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<SyncMessageResult> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawBytes = this.normalizeToUint8Array(data);

    const decoder = decoding.createDecoder(rawBytes);
    const encoder = encoding.createEncoder();

    // Use standard y-protocols sync handler
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

    // If client sent an update (SyncStep2 or Update), prepare broadcast update buffer
    let broadcastUpdate: Buffer | null = null;
    if (
      msgType === syncProtocol.messageYjsUpdate ||
      msgType === syncProtocol.messageYjsSyncStep2
    ) {
      const updateEncoder = encoding.createEncoder();
      // Re-encode as messageYjsUpdate for room broadcast
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
  }

  /**
   * Explicit SyncStep1:
   * Client sends its state vector -> Server replies with SyncStep2 + SyncStep1.
   */
  public async handleSyncStep1(
    projectId: string,
    docId: string,
    stateVector: Uint8Array | Buffer | number[] | string,
  ): Promise<Buffer> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawVector = this.normalizeToUint8Array(stateVector);

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep2(encoder, session.doc, rawVector);
    syncProtocol.writeSyncStep1(encoder, session.doc);

    return Buffer.from(encoding.toUint8Array(encoder));
  }

  /**
   * Explicit SyncStep2:
   * Client sends missing updates to apply directly to server's Y.Doc.
   */
  public async handleSyncStep2(
    projectId: string,
    docId: string,
    update: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<void> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawUpdate = this.normalizeToUint8Array(update);

    const decoder = decoding.createDecoder(rawUpdate);
    syncProtocol.readSyncStep2(decoder, session.doc, origin);
  }

  /**
   * Explicit SyncUpdate:
   * Client sends an incremental update -> Apply to server Y.Doc & return broadcastable frame.
   */
  public async handleSyncUpdate(
    projectId: string,
    docId: string,
    update: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<Buffer> {
    const session = await this.getOrCreateDoc(projectId, docId);
    const rawBytes = this.normalizeToUint8Array(update);

    // Apply incremental update
    Y.applyUpdate(session.doc, rawBytes, origin);

    // Re-package as standard sync update frame for room broadcast
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, rawBytes);
    return Buffer.from(encoding.toUint8Array(encoder));
  }

  /**
   * Returns current raw text from active Y.Doc.
   */
  public async getText(projectId: string, docId: string): Promise<string> {
    const session = await this.getOrCreateDoc(projectId, docId);
    return session.yText.toString();
  }

  /**
   * Flushes current Y.Doc state to persistent Docstore and caches binary snapshot in Redis.
   */
  public async flushDoc(projectId: string, docId: string): Promise<void> {
    const key = this.docKey(projectId, docId);
    const session = this.activeDocs.get(key);
    if (!session) return;

    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = undefined;
    }

    try {
      // 1. Cache binary update in Redis
      if (this.redis && this.redis.isReady()) {
        const client = this.redis.getClient();
        if (client) {
          const binarySnapshot = Y.encodeStateAsUpdate(session.doc);
          const base64 = Buffer.from(binarySnapshot).toString('base64');
          await client.set(
            this.redisKey(projectId, docId),
            base64,
            'EX',
            this.REDIS_SNAPSHOT_TTL_SECONDS,
          );
        }
      }

      // 2. Persist raw text to Docstore
      if (this.docstoreService) {
        const text = session.yText.toString();
        const lines = LineArrayEngine.textToLines(text);
        const currentDoc = await this.docstoreService
          .getDoc(projectId, docId)
          .catch(() => null);
        const nextVersion = (currentDoc?.version ?? 0) + 1;
        await this.docstoreService.updateDoc(projectId, docId, {
          lines,
          version: nextVersion,
        });
        this.logger.debug(
          `Flushed Y.Doc to Docstore (${lines.length} lines, v${nextVersion}): ${key}`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Error flushing Y.Doc ${key}: ${err?.message}`,
        err?.stack,
      );
    }
  }

  /**
   * Flushes and evicts in-memory session when room is empty.
   */
  public async evictDoc(projectId: string, docId: string): Promise<void> {
    const key = this.docKey(projectId, docId);
    const session = this.activeDocs.get(key);
    if (!session) return;

    await this.flushDoc(projectId, docId);
    this.activeDocs.delete(key);
    session.doc.destroy();
    this.logger.debug(`Evicted inactive Y.Doc: ${key}`);
  }

  private handleDocUpdated(
    projectId: string,
    docId: string,
    session: ActiveDocSession,
  ): void {
    session.lastActiveAt = Date.now();

    // Schedule debounced flush to Redis cache and Docstore
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
    }

    session.flushTimeout = setTimeout(() => {
      this.flushDoc(projectId, docId).catch((err) => {
        this.logger.warn(
          `Debounced flush failed for ${projectId}:${docId}: ${err?.message}`,
        );
      });
    }, this.FLUSH_DEBOUNCE_MS);
  }

  private normalizeToUint8Array(data: any): Uint8Array {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    if (typeof data === 'string') {
      return new Uint8Array(Buffer.from(data, 'base64'));
    }
    if (data && typeof data === 'object' && data.data) {
      return this.normalizeToUint8Array(data.data);
    }
    return new Uint8Array(0);
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
