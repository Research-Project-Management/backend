import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as Y from 'yjs';
import { PageRepository } from '../page/page.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { VersionEventType } from '@prisma/client';
import { COLLABORATION_REDIS_KEYS } from '../page/constants/page-redis-keys.constant';
import {
  DOCUMENT_COLLABORATION_QUEUE,
  DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
} from './constants/collaboration-queue.constants';

export interface DocSession {
  pageId: string;
  doc: Y.Doc;
  yText: Y.Text;
  subscribersCount: number;
  lastSavedContent?: string;
  debouncedSaveTimer?: NodeJS.Timeout;
  unloadTimer?: NodeJS.Timeout;
  lastActivityAt: number;
  lastCheckpointAt: number;
  editsSinceCheckpoint: number;
  lastEditorId?: string;
}

@Injectable()
export class YjsDocumentManager implements OnModuleDestroy {
  private readonly logger = new Logger(YjsDocumentManager.name);
  private readonly sessions = new Map<string, DocSession>();

  // Inactive document TTL before being unloaded from RAM: 5 minutes
  private static readonly SESSION_TTL_MS = 5 * 60 * 1000;
  // Debounce time before flushing Yjs text to PostgreSQL: 2 seconds
  private static readonly DEBOUNCE_SAVE_MS = 2000;
  // Auto-checkpoint triggers: 5 minutes or 50 edits
  public static readonly AUTO_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  public static readonly AUTO_CHECKPOINT_EDITS_THRESHOLD = 50;

  constructor(
    private readonly pageRepository: PageRepository,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisCacheService,
    @Optional()
    @InjectQueue(DOCUMENT_COLLABORATION_QUEUE)
    private readonly queue?: Queue,
  ) {}

  /**
   * Retrieves an existing Y.Doc or creates a new one seeded from Redis L2 snapshot / PostgreSQL L3.
   */
  async getOrCreateDoc(pageId: string): Promise<DocSession> {
    let session = this.sessions.get(pageId);

    if (session) {
      if (session.unloadTimer) {
        clearTimeout(session.unloadTimer);
        session.unloadTimer = undefined;
      }
      session.subscribersCount++;
      session.lastActivityAt = Date.now();
      return session;
    }

    const doc = new Y.Doc();
    const yText = doc.getText('monaco');

    let restoredFromRedis = false;
    // 1. Try restoring from Redis L2 Binary Snapshot (Zero-Data-Loss & CRDT history preservation)
    if (this.redis?.isReady()) {
      try {
        const cachedBase64 = await this.redis.get<string>(
          COLLABORATION_REDIS_KEYS.snapshot(pageId),
        );
        if (cachedBase64) {
          const snapshotU8 = Buffer.from(cachedBase64, 'base64');
          Y.applyUpdate(doc, snapshotU8);
          restoredFromRedis = true;
          this.logger.log(
            `[Yjs] Restored Y.Doc session for page ${pageId} from Redis L2 binary snapshot`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `[Yjs] Failed to recover snapshot from Redis for ${pageId}: ${err?.message || err}`,
        );
      }
    }

    // 2. Cold load fallback from PostgreSQL (L3) if not found in Redis
    let initialText = '';
    if (!restoredFromRedis) {
      try {
        const page = await this.pageRepository.findPageById(pageId);
        if (page && page.content) {
          if (typeof page.content === 'string') {
            initialText = page.content;
          } else if (typeof page.content === 'object') {
            initialText =
              (page.content as any).text ||
              (page.content as any).content ||
              (page.content as any).source ||
              '';
          }
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to load initial page content for ${pageId}: ${err?.message || err}`,
        );
      }

      if (initialText) {
        yText.insert(0, initialText);
      }

      // Populate initial snapshot to Redis L2
      await this.saveSnapshotToRedis(pageId, doc);
    } else {
      initialText = yText.toJSON();
    }

    session = {
      pageId,
      doc,
      yText,
      subscribersCount: 1,
      lastSavedContent: initialText,
      lastActivityAt: Date.now(),
      lastCheckpointAt: Date.now(),
      editsSinceCheckpoint: 0,
    };

    doc.on('update', () => {
      this.scheduleDebouncedSave(pageId);
    });

    this.sessions.set(pageId, session);
    this.logger.log(
      `[Yjs] Initialized Y.Doc session for page ${pageId} (length: ${initialText.length} chars, source: ${restoredFromRedis ? 'Redis L2' : 'PostgreSQL L3'})`,
    );

    return session;
  }

  /**
   * Applies an incoming binary Yjs update to the in-memory document,
   * tracks editing velocity, triggers continuous auto-checkpoints,
   * and records the op to Redis ZADD for keystroke-level history replay.
   */
  applyUpdate(pageId: string, update: Uint8Array, editorId?: string): void {
    const session = this.sessions.get(pageId);
    if (!session) return;

    session.lastActivityAt = Date.now();
    session.editsSinceCheckpoint++;
    if (editorId) {
      session.lastEditorId = editorId;
    }

    Y.applyUpdate(session.doc, update, 'remote-socket');

    // Record op to Redis ZADD for keystroke-level history (fire-and-forget)
    this.recordOpLog(pageId, update).catch(() => void 0);

    // Auto-checkpoint check: 5 minutes or 50 edits
    const timeSinceLastCheckpoint = Date.now() - session.lastCheckpointAt;
    if (
      session.editsSinceCheckpoint >=
        YjsDocumentManager.AUTO_CHECKPOINT_EDITS_THRESHOLD ||
      timeSinceLastCheckpoint >= YjsDocumentManager.AUTO_CHECKPOINT_INTERVAL_MS
    ) {
      this.triggerAutoCheckpoint(pageId).catch((err) =>
        this.logger.warn(
          `Auto-checkpoint notice for ${pageId}: ${err?.message || err}`,
        ),
      );
    }
  }

  /**
   * Records a Yjs binary update to Redis Sorted Set (ZADD) with timestamp as score.
   * Keeps max 2000 ops per document (LTRIM-equivalent via ZREMRANGEBYRANK).
   * Enables Overleaf-style keystroke-level time-machine history scrubbing.
   */
  async recordOpLog(pageId: string, update: Uint8Array): Promise<void> {
    if (!this.redis?.isReady()) return;
    try {
      const key = COLLABORATION_REDIS_KEYS.oplog(pageId);
      const score = Date.now();
      const member = Buffer.from(update).toString('base64');

      // ZADD score member
      await this.redis.zadd(key, score, member);

      // Trim to max 1000 ops: remove oldest beyond cap (ZREMRANGEBYRANK 0 -(1001))
      await this.redis.zremrangebyrank(key, 0, -1001);

      // Ephemeral 2-hour TTL (protects Redis RAM, cold storage absorbs history)
      await this.redis.expire(key, 2 * 3600);
    } catch (err: any) {
      // Non-critical — do not propagate, just warn
      this.logger.debug(
        `[Yjs] Op log write skipped for page ${pageId}: ${err?.message || err}`,
      );
    }
  }

  /**
   * Gets current state vector of the server's Y.Doc.
   */
  getStateVector(pageId: string): Uint8Array | null {
    const session = this.sessions.get(pageId);
    if (!session) return null;
    return Y.encodeStateVector(session.doc);
  }

  /**
   * Computes missing updates for a client that has clientStateVector.
   */
  encodeStateAsUpdate(
    pageId: string,
    clientStateVector?: Uint8Array,
  ): Uint8Array | null {
    const session = this.sessions.get(pageId);
    if (!session) return null;
    return Y.encodeStateAsUpdate(session.doc, clientStateVector);
  }

  /**
   * Reads current text directly from Y.Text.
   */
  getText(pageId: string): string {
    const session = this.sessions.get(pageId);
    return session ? session.yText.toJSON() : '';
  }

  /**
   * Checks if an active Y.Doc session exists in memory.
   */
  hasActiveSession(pageId: string): boolean {
    return this.sessions.has(pageId);
  }

  /**
   * Atomically replaces the entire text of a collaborative document (e.g. on Version Restore),
   * applies it via a single Yjs transaction, updates Redis L2 snapshot immediately,
   * and returns the generated update binary to broadcast to all connected WebSocket clients.
   */
  async replaceText(
    pageId: string,
    newText: string,
    originUserId?: string,
  ): Promise<Uint8Array | null> {
    const session = await this.getOrCreateDoc(pageId);
    let generatedUpdate: Uint8Array | null = null;

    const updateHandler = (update: Uint8Array, origin: any) => {
      if (origin === 'restore-version') {
        generatedUpdate = update;
      }
    };
    session.doc.on('update', updateHandler);

    try {
      session.doc.transact(() => {
        const currentLen = session.yText.length;
        if (currentLen > 0) {
          session.yText.delete(0, currentLen);
        }
        if (newText && newText.length > 0) {
          session.yText.insert(0, newText);
        }
      }, 'restore-version');
    } finally {
      session.doc.off('update', updateHandler);
    }

    session.lastSavedContent = newText;
    session.lastActivityAt = Date.now();
    session.editsSinceCheckpoint = 0;
    session.lastCheckpointAt = Date.now();
    if (originUserId) {
      session.lastEditorId = originUserId;
    }

    // Persist snapshot to Redis L2 immediately
    await this.saveSnapshotToRedis(pageId, session.doc);

    return generatedUpdate;
  }

  /**
   * Schedules a debounced flush to PostgreSQL after edits pause.
   */
  scheduleDebouncedSave(pageId: string): void {
    const session = this.sessions.get(pageId);
    if (!session) return;

    if (session.debouncedSaveTimer) {
      clearTimeout(session.debouncedSaveTimer);
    }

    session.debouncedSaveTimer = setTimeout(() => {
      void this.flushToDatabase(pageId);
    }, YjsDocumentManager.DEBOUNCE_SAVE_MS);
  }

  /**
   * Flushes current Yjs document text directly to PostgreSQL and L2 Redis snapshot.
   */
  async flushToDatabase(pageId: string): Promise<void> {
    const session = this.sessions.get(pageId);
    if (!session) return;

    if (session.debouncedSaveTimer) {
      clearTimeout(session.debouncedSaveTimer);
      session.debouncedSaveTimer = undefined;
    }

    const currentText = session.yText.toJSON();

    // Persist to L2 Redis Snapshot unconditionally on flush
    await this.saveSnapshotToRedis(pageId, session.doc);

    if (currentText === session.lastSavedContent) {
      return;
    }

    try {
      await this.pageRepository.updatePage(pageId, {
        content: currentText,
      });
      session.lastSavedContent = currentText;
      this.logger.debug(
        `[Yjs] Flushed page ${pageId} to PostgreSQL (${currentText.length} chars)`,
      );
    } catch (err: any) {
      this.logger.error(
        `[Yjs] Error flushing page ${pageId} to PostgreSQL: ${err?.message || err}`,
      );
    }
  }

  /**
   * Encodes Y.Doc into binary state update and persists to Redis L2 cache with 7-day TTL.
   */
  async saveSnapshotToRedis(pageId: string, doc: Y.Doc): Promise<void> {
    if (!this.redis?.isReady()) return;
    try {
      const update = Y.encodeStateAsUpdate(doc);
      const base64 = Buffer.from(update).toString('base64');
      // Store with 7 days TTL (L2 cache)
      await this.redis.set(
        COLLABORATION_REDIS_KEYS.snapshot(pageId),
        base64,
        7 * 24 * 3600,
      );
    } catch (err: any) {
      this.logger.warn(
        `[Yjs] Failed to save snapshot to Redis for page ${pageId}: ${err?.message || err}`,
      );
    }
  }

  /**
   * Triggers an auto-checkpoint after thresholds are met (5m or 50 edits).
   * Resets editing velocity counters and enqueues checkpoint creation.
   */
  async triggerAutoCheckpoint(pageId: string): Promise<void> {
    const session = this.sessions.get(pageId);
    if (!session) return;

    const edits = session.editsSinceCheckpoint;
    const editorId = session.lastEditorId;
    session.lastCheckpointAt = Date.now();
    session.editsSinceCheckpoint = 0;

    await this.createCollaborativeCheckpoint(
      pageId,
      editorId,
      `Auto-checkpoint (${edits} edits)`,
      edits,
    );
  }

  /**
   * Creates a collaborative checkpoint version for version history (Overleaf style).
   * Offloads to BullMQ background queue if available, otherwise falls back to direct Prisma write.
   */
  async createCollaborativeCheckpoint(
    pageId: string,
    savedById?: string,
    label?: string,
    editsCount?: number,
  ): Promise<void> {
    const session = this.sessions.get(pageId);
    const content = session ? session.yText.toJSON() : '';

    // If BullMQ queue is available, offload to background worker
    if (this.queue) {
      try {
        await this.queue.add(
          DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
          {
            pageId,
            content,
            savedById,
            label: label || 'Collaborative autosave checkpoint',
            editsCount,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
          },
        );
        this.logger.debug(
          `[Yjs] Dispatched collaborative checkpoint to BullMQ queue for page ${pageId}`,
        );
        return;
      } catch (err: any) {
        this.logger.warn(
          `[Yjs] Failed to enqueue checkpoint to BullMQ, falling back to direct write: ${err?.message || err}`,
        );
      }
    }

    // Direct write fallback (e.g. queue unavailable or in unit test environment)
    if (!this.prisma) return;
    try {
      const now = Date.now();
      await this.prisma.pageVersion.create({
        data: {
          pageId,
          content,
          savedById,
          eventType: VersionEventType.collaborative_checkpoint,
          label: label || 'Collaborative autosave checkpoint',
        },
      });

      // Compact Redis oplog — prune ops captured in this snapshot
      if (this.redis?.isReady()) {
        const oplogKey = COLLABORATION_REDIS_KEYS.oplog(pageId);
        await this.redis
          .zremrangebyscore(oplogKey, '-inf', now)
          .catch(() => {});
      }

      this.logger.log(
        `[Yjs] Created direct collaborative checkpoint for page ${pageId} and compacted oplog`,
      );
    } catch (err: any) {
      this.logger.warn(
        `[Yjs] Failed to create collaborative checkpoint: ${err?.message || err}`,
      );
    }
  }

  /**
   * Decrements active subscriber count when a socket disconnects or leaves room.
   */
  handleClientLeave(pageId: string): void {
    const session = this.sessions.get(pageId);
    if (!session) return;

    session.subscribersCount = Math.max(0, session.subscribersCount - 1);

    if (session.subscribersCount === 0) {
      this.flushToDatabase(pageId).catch((err) =>
        this.logger.error(`Error flushing on last leave: ${err}`),
      );

      session.unloadTimer = setTimeout(() => {
        this.destroySession(pageId);
      }, YjsDocumentManager.SESSION_TTL_MS);
    }
  }

  private destroySession(pageId: string): void {
    const session = this.sessions.get(pageId);
    if (!session) return;

    if (session.debouncedSaveTimer) {
      clearTimeout(session.debouncedSaveTimer);
    }
    if (session.unloadTimer) {
      clearTimeout(session.unloadTimer);
    }

    session.doc.destroy();
    this.sessions.delete(pageId);
    this.logger.log(`[Yjs] Unloaded inactive Y.Doc session for page ${pageId}`);
  }

  /**
   * Graceful shutdown: persist all dirty documents to PostgreSQL and Redis before exiting.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log(
      '[Yjs] Flushing all active document sessions before shutdown...',
    );
    const flushPromises: Promise<void>[] = [];
    for (const [pageId, session] of this.sessions.entries()) {
      flushPromises.push(this.flushToDatabase(pageId));
      flushPromises.push(this.saveSnapshotToRedis(pageId, session.doc));
    }
    await Promise.all(flushPromises);
    for (const [pageId] of this.sessions.entries()) {
      this.destroySession(pageId);
    }
  }
}
