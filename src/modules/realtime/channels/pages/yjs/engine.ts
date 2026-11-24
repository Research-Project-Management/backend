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
import { applyTextEditsAndCapture } from './util';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';

import { RedisCacheService, RedisPubSubService, SystemResourceGovernor } from '@/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  PAGES_REALTIME_DEFAULTS,
  PAGES_REDIS_KEYS,
  PagesRealtimeConfigService,
  type PagesYjsConfig,
} from '../config';
import { YjsSyncProtocol, YjsUpdateValidator } from './sync';
import { YjsCursorDiffEngine, type YjsCursorPreservingEdit } from './merge';
import {
  type ActiveDocSession,
  type SyncMessageResult,
  type YjsClusterRelayMessage,
  yjsDocKey,
} from '../types';
import {
  type YjsRelaySubscriber,
  deleteRedisSnapshotHelper,
  handleClusterRelayMessageHelper,
  initRedisClusterRelayHelper,
  publishClusterRelayHelper,
  saveBinaryToRedisHelper,
} from './cluster';
import {
  type YjsPersistenceContext,
  evictDocHelper,
  executeFlushDocHelper,
  hydrateOrInitYDocSessionHelper,
} from './persistence';

export type { ActiveDocSession, SyncMessageResult, YjsClusterRelayMessage };

@Injectable()
export class YjsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YjsService.name);
  public readonly instanceId = randomUUID();
  private pubSubSubscriber: YjsRelaySubscriber | null = null;

  private readonly activeDocs = new Map<string, ActiveDocSession>();
  private readonly projectDocKeys = new Map<string, Set<string>>();
  private readonly inFlightDocInits = new Map<
    string,
    Promise<ActiveDocSession>
  >();
  private readonly inFlightFlushes = new Map<string, Promise<void>>();
  private readonly yjsConfig: PagesYjsConfig;
  private sweepTimer: NodeJS.Timeout | null = null;

  private readonly validator: YjsUpdateValidator;
  private readonly syncProtocol: YjsSyncProtocol;
  private server: Server | null = null;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() validator?: YjsUpdateValidator,
    @Optional() private readonly config?: PagesRealtimeConfigService,
    @Optional() private readonly resourceGovernor?: SystemResourceGovernor,
    @Optional() private readonly pubSub?: RedisPubSubService,
  ) {
    const raw = this.config?.getYjsConfig?.();
    const d = PAGES_REALTIME_DEFAULTS.yjs;
    this.yjsConfig = {
      maxUpdateSizeBytes: raw?.maxUpdateSizeBytes ?? d.maxUpdateSizeBytes,
      maxDocumentSizeBytes: raw?.maxDocumentSizeBytes ?? d.maxDocumentSizeBytes,
      flushDebounceMs: raw?.flushDebounceMs ?? d.flushDebounceMs,
      maxFlushDelayMs: raw?.maxFlushDelayMs ?? d.maxFlushDelayMs,
      flushRetryDelayMs: raw?.flushRetryDelayMs ?? d.flushRetryDelayMs,
      flushLockTtlMs: raw?.flushLockTtlMs ?? d.flushLockTtlMs,
      idleThresholdMs: raw?.idleThresholdMs ?? d.idleThresholdMs,
      maxActiveDocs: raw?.maxActiveDocs ?? d.maxActiveDocs,
      sweepIntervalMs: raw?.sweepIntervalMs ?? d.sweepIntervalMs,
      redisSnapshotTtlSeconds:
        raw?.redisSnapshotTtlSeconds ?? d.redisSnapshotTtlSeconds,
    };
    this.validator = validator ?? new YjsUpdateValidator();
    this.syncProtocol = new YjsSyncProtocol(
      this.validator,
      this.logger,
      this.config,
    );
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
      flushDebounceMs: this.yjsConfig.flushDebounceMs,
      flushRetryDelayMs: this.yjsConfig.flushRetryDelayMs,
      flushLockTtlMs: this.yjsConfig.flushLockTtlMs,
      redisSnapshotTtlSeconds: this.yjsConfig.redisSnapshotTtlSeconds,
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
        this.logger.warn(
          `Error during Y.Doc idle sweep: ${(err as Error)?.message}`,
        );
      });
    }, this.yjsConfig.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  public async sweepIdleDocs(): Promise<number> {
    const now = Date.now();
    let evictedCount = 0;
    const advise = () =>
      this.resourceGovernor?.adviseEviction({
        activeCount: this.activeDocs.size,
        baseIdleTtlMs: this.yjsConfig.idleThresholdMs,
        hardCap: this.yjsConfig.maxActiveDocs,
      });
    const idleTtlMs =
      advise()?.effectiveIdleTtlMs ?? this.yjsConfig.idleThresholdMs;

    for (const [, session] of this.activeDocs.entries()) {
      if (now - session.lastActiveAt > idleTtlMs) {
        await this.evictDoc(session.projectId, session.docId);
        evictedCount++;
      }
    }
    if (evictedCount > 0) {
      this.logger.log(
        `Garbage collected ${evictedCount} idle Y.Doc in-memory session(s)`,
      );
    }

    const targetEvictions =
      advise()?.targetEvictions ??
      Math.max(0, this.activeDocs.size - this.yjsConfig.maxActiveDocs);
    if (targetEvictions > 0) {
      const sorted = [...this.activeDocs.values()].sort(
        (a, b) => a.lastActiveAt - b.lastActiveAt,
      );
      for (let i = 0; i < Math.min(targetEvictions, sorted.length); i++) {
        await this.evictDoc(sorted[i].projectId, sorted[i].docId);
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
      this.pubSub,
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
        redisSnapshotTtlSeconds: this.yjsConfig.redisSnapshotTtlSeconds,
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
    return PAGES_REDIS_KEYS.yjsBinary(projectId, docId);
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

  public async handleSyncMessage(
    projectId: string,
    docId: string,
    data: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<SyncMessageResult> {
    const session = await this.getOrCreateDoc(projectId, docId);
    return this.syncProtocol.handleSyncMessage(
      session,
      projectId,
      docId,
      data,
      origin,
    );
  }

  public async handleSyncStep1(
    projectId: string,
    docId: string,
    stateVector: Uint8Array | Buffer | number[] | string,
  ): Promise<Buffer> {
    const session = await this.getOrCreateDoc(projectId, docId);
    return this.syncProtocol.handleSyncStep1(session, stateVector);
  }

  public async handleSyncStep2(
    projectId: string,
    docId: string,
    update: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<void> {
    const session = await this.getOrCreateDoc(projectId, docId);
    this.syncProtocol.handleSyncStep2(session, update, origin);
  }

  public async handleSyncUpdate(
    projectId: string,
    docId: string,
    update: Uint8Array | Buffer | number[] | string,
    origin: string,
  ): Promise<Buffer> {
    const session = await this.getOrCreateDoc(projectId, docId);
    return this.syncProtocol.handleSyncUpdate(session, update, origin);
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

    session.currentVersion = undefined;
    const captured = applyTextEditsAndCapture(
      session.doc,
      session.yText,
      current,
      nextText,
      'rest-api',
    );
    session.lastFlushedText = nextText;
    if (!captured) return null;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, captured);
    return Buffer.from(encoding.toUint8Array(encoder));
  }

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
    publishClusterRelayHelper(
      this.redis,
      this.logger,
      this.instanceId,
      { type: 'external-text', projectId, docId, text: nextText },
      this.pubSub,
    );
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
        this.yjsConfig.redisSnapshotTtlSeconds,
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

    if (elapsedSinceFirstUnflushed >= this.yjsConfig.maxFlushDelayMs) {
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
    }, this.yjsConfig.flushDebounceMs);
    session.flushTimeout.unref?.();
  }
}
