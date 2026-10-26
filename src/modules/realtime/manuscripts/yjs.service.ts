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
  lastFlushedRev?: number;
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
  private readonly inFlightFlushes = new Map<string, Promise<void>>();

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
      session.doc.transact(() => {
        const edits = this.computeCursorPreservingEdits(current, nextText);
        // Apply in reverse order so character offsets remain valid
        for (let i = edits.length - 1; i >= 0; i--) {
          const edit = edits[i];
          if (edit.deleteLen > 0) {
            session.yText.delete(edit.index, edit.deleteLen);
          }
          if (edit.insertText.length > 0) {
            session.yText.insert(edit.index, edit.insertText);
          }
        }
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

  /**
   * Computes minimal cursor-preserving character edits between `current` and `nextText`.
   * Uses line-level LCS anchoring for multi-hunk mutations so unchanged middle lines
   * are never deleted and re-inserted (preserving collaborator Yjs RelativePositions).
   */
  public computeCursorPreservingEdits(
    current: string,
    nextText: string,
  ): Array<{ index: number; deleteLen: number; insertText: string }> {
    if (current === nextText) return [];

    const trimSpanToSingleEdit = (
      baseOffset: number,
      oldSpan: string,
      newSpan: string,
    ): { index: number; deleteLen: number; insertText: string } | null => {
      if (oldSpan === newSpan) return null;
      let prefix = 0;
      const maxPrefix = Math.min(oldSpan.length, newSpan.length);
      while (prefix < maxPrefix && oldSpan[prefix] === newSpan[prefix])
        prefix++;
      if (
        prefix > 0 &&
        oldSpan.charCodeAt(prefix - 1) >= 0xd800 &&
        oldSpan.charCodeAt(prefix - 1) <= 0xdbff
      ) {
        prefix--;
      }

      let suffix = 0;
      const maxSuffix = Math.min(oldSpan.length, newSpan.length) - prefix;
      while (
        suffix < maxSuffix &&
        oldSpan[oldSpan.length - 1 - suffix] ===
          newSpan[newSpan.length - 1 - suffix]
      ) {
        suffix++;
      }
      if (
        suffix > 0 &&
        oldSpan.charCodeAt(oldSpan.length - suffix) >= 0xdc00 &&
        oldSpan.charCodeAt(oldSpan.length - suffix) <= 0xdfff
      ) {
        suffix--;
      }

      return {
        index: baseOffset + prefix,
        deleteLen: oldSpan.length - prefix - suffix,
        insertText: newSpan.slice(prefix, newSpan.length - suffix),
      };
    };

    const oldLines = current.match(/[^\n]*\n|[^\n]+/g) ?? [];
    const newLines = nextText.match(/[^\n]*\n|[^\n]+/g) ?? [];

    // Fallback to single-span diff for very large line counts or single-line docs
    if (
      oldLines.length <= 1 ||
      newLines.length <= 1 ||
      oldLines.length * newLines.length > 400_000
    ) {
      const single = trimSpanToSingleEdit(0, current, nextText);
      return single ? [single] : [];
    }

    // Trim common leading and trailing lines first
    let startLine = 0;
    while (
      startLine < oldLines.length &&
      startLine < newLines.length &&
      oldLines[startLine] === newLines[startLine]
    ) {
      startLine++;
    }

    let endOld = oldLines.length;
    let endNew = newLines.length;
    while (
      endOld > startLine &&
      endNew > startLine &&
      oldLines[endOld - 1] === newLines[endNew - 1]
    ) {
      endOld--;
      endNew--;
    }

    const midOld = oldLines.slice(startLine, endOld);
    const midNew = newLines.slice(startLine, endNew);
    const m = midOld.length;
    const n = midNew.length;

    if (m * n > 250_000) {
      const single = trimSpanToSingleEdit(0, current, nextText);
      return single ? [single] : [];
    }

    // DP LCS table on middle lines
    const dp = new Int32Array((m + 1) * (n + 1));
    const width = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * width + j] = 1 + dp[(i + 1) * width + (j + 1)];
        } else {
          const down = dp[(i + 1) * width + j];
          const right = dp[i * width + (j + 1)];
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }

    // Walk LCS anchors to partition non-matching line hunks
    let baseCharOffset = 0;
    for (let k = 0; k < startLine; k++) {
      baseCharOffset += oldLines[k].length;
    }

    const edits: Array<{
      index: number;
      deleteLen: number;
      insertText: string;
    }> = [];
    let i = 0;
    let j = 0;
    let hunkOldStart = 0;
    let hunkNewStart = 0;
    let hunkCharOffset = baseCharOffset;

    const flushHunk = (oldEndIdx: number, newEndIdx: number) => {
      if (oldEndIdx === hunkOldStart && newEndIdx === hunkNewStart) return;
      const oldSpan = midOld.slice(hunkOldStart, oldEndIdx).join('');
      const newSpan = midNew.slice(hunkNewStart, newEndIdx).join('');
      const edit = trimSpanToSingleEdit(hunkCharOffset, oldSpan, newSpan);
      if (edit) edits.push(edit);
      hunkCharOffset += oldSpan.length;
    };

    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        flushHunk(i, j);
        hunkCharOffset += midOld[i].length;
        i++;
        j++;
        hunkOldStart = i;
        hunkNewStart = j;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        i++;
      } else {
        j++;
      }
    }
    flushHunk(m, n);

    return edits;
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
    if (!this.isActive(projectId, docId)) {
      await this.deleteRedisSnapshot(projectId, docId);
      return { active: false, frame: null };
    }
    const frame = this.replaceTextIfActive(projectId, docId, nextText);
    const session = this.activeDocs.get(key);
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

    try {
      const tasks: Promise<unknown>[] = [];

      if (this.redis && this.redis.isReady()) {
        tasks.push(this.saveBinaryToRedis(projectId, docId, session.doc));
      }

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
    } else {
      try {
        await this.flushDoc(projectId, docId);
      } catch {
        // Ignore flush errors on forced eviction
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
