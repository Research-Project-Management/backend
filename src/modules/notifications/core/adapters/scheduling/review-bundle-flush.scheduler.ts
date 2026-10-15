/**
 * notifications/core/adapters/scheduling/review-bundle-flush.scheduler.ts
 *
 * Driving adapter: every minute, collapses review-notification bundles whose
 * window has elapsed into digests (ReviewNotificationBundlingUseCase.flushDue).
 * A Postgres transaction-scoped advisory lock ensures only one backend
 * instance sweeps at a time.
 */

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { ManuscriptNotificationType } from '@prisma/client';
import { ReviewNotificationBundlingUseCase } from '../../use-cases/review-notification-bundling.use-case';
import { REVIEW_NOTIFICATION_TYPES } from '../../domain/value-objects/review-bundle';

const SWEEP_INTERVAL_MS = 60_000;
const ADVISORY_LOCK_KEY = 74_210_031; // arbitrary, unique to this job
const MAX_USERS_PER_SWEEP = 500;

@Injectable()
export class ReviewBundleFlushScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReviewBundleFlushScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bundling: ReviewNotificationBundlingUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.REVIEW_BUNDLE_SCHEDULER === 'off'
    ) {
      return;
    }
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep; returns the number of digests produced. Public for tests/ops. */
  async sweep(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`;
          if (!rows?.[0]?.locked) return 0;

          // Smallest allowed window is 1 minute: anything newer cannot be due.
          const users = await this.prisma.manuscriptNotification.findMany({
            where: {
              isRead: false,
              type: {
                in: [
                  ...REVIEW_NOTIFICATION_TYPES,
                ] as ManuscriptNotificationType[],
              },
              createdAt: { lte: new Date(now.getTime() - 60_000) },
            },
            distinct: ['userId'],
            select: { userId: true },
            take: MAX_USERS_PER_SWEEP,
          });

          let digests = 0;
          for (const { userId } of users) {
            try {
              digests += (await this.bundling.flushDue(userId)).length;
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `Review bundle flush failed for user ${userId}: ${errMsg}`,
              );
            }
          }
          if (digests > 0) {
            this.logger.log(`Flushed ${digests} review notification digest(s)`);
          }
          return digests;
        },
        { timeout: SWEEP_INTERVAL_MS - 5_000 },
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Review bundle sweep skipped: ${errMsg}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
