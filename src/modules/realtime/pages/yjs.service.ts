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
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { YjsUpdateValidator } from './yjs-update-validator';
import {
  YjsCursorDiffEngine,
  type YjsCursorPreservingEdit,
} from './yjs-cursor-diff.engine';
import { RealtimeConfigService } from '../core/realtime.config';
import { RealtimeException } from '../core/ws-errors';
import {
  type ActiveDocSession,
  type SyncMessageResult,
  type YjsClusterRelayMessage,
  deleteRedisSnapshotHelper,
  handleClusterRelayMessageHelper,
  initRedisClusterRelayHelper,
  publishClusterRelayHelper,
  saveBinaryToRedisHelper,
  yjsDocKey,
  yjsRedisBinaryKey,
} from './yjs-cluster-relay.helper';
import {
  type YjsPersistenceContext,
  evictDocHelper,
  executeFlushDocHelper,
  hydrateOrInitYDocSessionHelper,
} from './yjs-persistence-flusher.helper';

export type { ActiveDocSession, SyncMessageResult, YjsClusterRelayMessage };

@Injectable()
export class YjsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YjsService.name);
  public readonly instanceId = randomUUID();
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

  private getPersistenceContext(): YjsPersistenceContext {
    return {
      instanceId: this.instanceId,
      logger: this.logger,
      redis: this.redis,
      docstoreService: this.docstoreService,
      server: this.server,
      activeDocs: this.activeDocs,
      projectDocKeys: this.projectDocKeys,
      inFlightFlushes: this.inFlightFlushes,
      flushDebounceMs: this.FLUSH_DEBOUNCE_MS,
      flushDoc: (projectId, docId) => this.flushDoc(projectId, docId),
      evictDoc: (projectId, docId, options) =>
        this.evictDoc(projectId, docId, options),
      onDocUpdated: (projectId, docId, session) =>
        this.handleDocUpdated(projectId, docId, session),
    };
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
    this.pubSubSubscriber = await initRedisClusterRelayHelper(
      this.redis,
      this.logger,
      (raw) => this.handleClusterRelayRaw(raw),
    );
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
    handleClusterRelayMessageHelper(
      {
        instanceId: this.instanceId,
        activeDocs: this.activeDocs,
        projectDocKeys: this.projectDocKeys,
        server: this.server,
        redis: this.redis,
        logger: this.logger,
      },
      msg,
    );
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

  public getRedisBinaryKey(projectId: string, docId: string): string {
    return yjsRedisBinaryKey(projectId, docId);
  }

  public async deleteRedisSnapshot(
    projectId: string,
    docId: string,
  ): Promise<void> {
    await deleteRedisSnapshotHelper(this.redis, this.logger, projectId, docId);
  }

  public async getOrCreateDoc(
    projectId: string,
    docId: string,
  ): Promise<ActiveDocSession> {
    const key = yjsDocKey(projectId, docId);
    const existing = this.activeDocs.get(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const inFlight = this.inFlightDocInits.get(key);
    if (inFlight) {
      return inFlight;
    }

    const initPromise = hydrateOrInitYDocSessionHelper(
      this.getPersistenceContext(),
      projectId,
      docId,
    ).finally(() => {
      this.inFlightDocInits.delete(key);
    });

    this.inFlightDocInits.set(key, initPromise);
    return initPromise;
  }

  private assertPostApplySizeBeforeMutation(
    session: ActiveDocSession,
    applyAction: (targetDoc: Y.Doc) => void,
    incomingBytes: number = 0,
  ): void {
    const doc = session.doc;
    const maxDocSize =
      this.config?.getMaxDocumentSizeBytes() ?? 20 * 1024 * 1024;
    let approxChars = 0;
    for (const item of doc.share.values()) {
      const anyItem = item as unknown as { length?: number };
      if (typeof anyItem?.length === 'number') {
        approxChars += anyItem.length;
      }
    }
    const approxCumulative = (session.approxEncodedBytes ?? 0) + incomingBytes;
    if (
      maxDocSize <= 1024 ||
      approxChars * 4 + approxCumulative > maxDocSize / 2
    ) {
      const tempDoc = new Y.Doc();
      tempDoc.getText('latex');
      Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(doc));
      applyAction(tempDoc);
      this.validator.validatePostApplySize(
        tempDoc,
        maxDocSize,
        approxCumulative,
      );
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
        this.assertPostApplySizeBeforeMutation(
          session,
          (tempDoc) => {
            const tempDec = decoding.createDecoder(rawBytes);
            const tempEnc = encoding.createEncoder();
            syncProtocol.readSyncMessage(tempDec, tempEnc, tempDoc, origin);
          },
          rawBytes.byteLength,
        );
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
        session.approxEncodedBytes =
          (session.approxEncodedBytes ?? 0) + rawBytes.byteLength;
        this.validator.validatePostApplySize(
          session.doc,
          this.config?.getMaxDocumentSizeBytes(),
          session.approxEncodedBytes,
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
        this.assertPostApplySizeBeforeMutation(session, (tempDoc) => {
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
      this.assertPostApplySizeBeforeMutation(session, (tempDoc) => {
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

      this.assertPostApplySizeBeforeMutation(session, (tempDoc) => {
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
    return this.activeDocs.has(yjsDocKey(projectId, docId));
  }

  public replaceTextIfActive(
    projectId: string,
    docId: string,
    nextText: string,
  ): Buffer | null {
    const session = this.activeDocs.get(yjsDocKey(projectId, docId));
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
    const key = yjsDocKey(projectId, docId);
    const inFlight = this.inFlightFlushes.get(key);
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    publishClusterRelayHelper(this.redis, this.logger, this.instanceId, {
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
      await saveBinaryToRedisHelper(
        this.redis,
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
    const key = yjsDocKey(projectId, docId);
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

    const flushPromise = executeFlushDocHelper(
      this.getPersistenceContext(),
      projectId,
      docId,
      key,
      session,
    );
    this.inFlightFlushes.set(key, flushPromise);
    try {
      await flushPromise;
    } finally {
      if (this.inFlightFlushes.get(key) === flushPromise) {
        this.inFlightFlushes.delete(key);
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

  public async evictDoc(
    projectId: string,
    docId: string,
    options?: { skipFlush?: boolean },
  ): Promise<void> {
    await evictDocHelper(
      this.getPersistenceContext(),
      projectId,
      docId,
      options,
    );
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
    session.flushTimeout.unref?.();
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
