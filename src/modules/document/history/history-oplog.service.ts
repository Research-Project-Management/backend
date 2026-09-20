import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as Y from 'yjs';
import { RedisCacheService } from '@/core/cache/redis.service';
import { PrismaService } from '@/core/database/prisma.service';
import { COLLABORATION_REDIS_KEYS } from '../page/constants/page-redis-keys.constant';
import { PageService } from '../page/page.service';
import { toContentString } from '../page/utils/page.utils';

export interface OpLogEntry {
  timestamp: number;
  sizeBytes: number;
}

export interface OpLogTimeline {
  pageId: string;
  entries: OpLogEntry[];
  totalOps: number;
  oldestMs: number | null;
  newestMs: number | null;
}

@Injectable()
export class HistoryOpLogService {
  private readonly logger = new Logger(HistoryOpLogService.name);

  constructor(
    private readonly pageService: PageService,
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async getTimeline(
    pageId: string,
    fromMs?: number,
    toMs?: number,
  ): Promise<OpLogTimeline> {
    if (!this.redis?.isReady()) {
      return {
        pageId,
        entries: [],
        totalOps: 0,
        oldestMs: null,
        newestMs: null,
      };
    }
    const key = COLLABORATION_REDIS_KEYS.oplog(pageId);
    const raw = await this.redis.zrangebyscore(
      key,
      (fromMs as any) ?? '-inf',
      (toMs as any) ?? '+inf',
    );
    const entries: OpLogEntry[] = raw.map(({ member, score }) => ({
      timestamp: score,
      sizeBytes: Math.round((member.length * 3) / 4),
    }));
    return {
      pageId,
      entries,
      totalOps: entries.length,
      oldestMs: entries[0]?.timestamp ?? null,
      newestMs: entries[entries.length - 1]?.timestamp ?? null,
    };
  }

  /**
   * Reconstructs document text at an arbitrary historical point in time.
   * Multi-tiered retrieval (Overleaf-style):
   * 1. If hot binary ops exist in Redis oplog up to targetMs, replays them on a clean Y.Doc
   *    preserving exact causal Yjs clock ordering without text mismatch.
   * 2. If targetMs is older than the hot Redis window (ops compacted/pruned), falls back
   *    to cold storage (closest PostgreSQL PageVersion snapshot at or before targetMs).
   * 3. If neither exists, falls back to the baseline page content.
   */
  async replayToPoint(pageId: string, targetMs: number): Promise<string> {
    const page = await this.pageService.findPageById(pageId);
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    // 1. Hot Tier: Replay from Redis binary oplog if ops exist up to targetMs
    if (this.redis?.isReady()) {
      const key = COLLABORATION_REDIS_KEYS.oplog(pageId);
      const raw = await this.redis.zrangebyscore(key, '-inf', targetMs);

      if (raw.length > 0) {
        const doc = new Y.Doc();
        let appliedCount = 0;

        for (const { member } of raw) {
          try {
            Y.applyUpdate(doc, Buffer.from(member, 'base64'));
            appliedCount++;
          } catch (err: any) {
            this.logger.warn(
              `[OpLog] Skipping corrupt op for page ${pageId}: ${err?.message}`,
            );
          }
        }

        const replayedText = doc.getText('monaco').toJSON();
        doc.destroy();

        if (replayedText && replayedText.trim().length > 0) {
          this.logger.debug(
            `[OpLog] Replayed ${appliedCount} hot ops for page ${pageId} at ${new Date(targetMs).toISOString()}`,
          );
          return replayedText;
        }
      }
    }

    // 2. Cold Tier: Fall back to closest PostgreSQL PageVersion snapshot at or before targetMs
    if (this.prisma?.pageVersion) {
      const nearestVersion = await this.prisma.pageVersion.findFirst({
        where: {
          pageId,
          createdAt: { lte: new Date(targetMs) },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          content: true,
          createdAt: true,
        },
      });

      if (nearestVersion && nearestVersion.content !== null) {
        this.logger.debug(
          `[OpLog] Retrieved cold snapshot ${nearestVersion.id} for page ${pageId} at ${new Date(targetMs).toISOString()}`,
        );
        return nearestVersion.content;
      }
    }

    // 3. Fallback to baseline page content
    return toContentString(page.content);
  }

  /**
   * Compacts Redis oplog by pruning operations that are already captured in PostgreSQL snapshots.
   * Prevents Redis RAM bloat by removing ops older than olderThanMs.
   */
  async compactOpLog(pageId: string, olderThanMs: number): Promise<number> {
    if (!this.redis?.isReady()) return 0;
    try {
      const key = COLLABORATION_REDIS_KEYS.oplog(pageId);
      const removed = await this.redis.zremrangebyscore(
        key,
        '-inf',
        olderThanMs,
      );
      if (removed > 0) {
        this.logger.log(
          `[OpLog] Compacted ${removed} ops older than ${new Date(olderThanMs).toISOString()} for page ${pageId}`,
        );
      }
      return removed;
    } catch (err: any) {
      this.logger.warn(
        `[OpLog] Compaction failed for page ${pageId}: ${err?.message}`,
      );
      return 0;
    }
  }
}
