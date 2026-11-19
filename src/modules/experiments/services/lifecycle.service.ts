import {
  Injectable,
  Logger,
  Inject,
  Optional,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService, shouldRunWorkerConsumers } from '@/core';
import {
  BlobService,
  StorageLifecycleConfiguration,
  UPLOAD_SESSION_REPOSITORY,
  type ISessionRepository,
} from '@/modules/files';
import { EXPERIMENT_NODE_REPOSITORY } from '../experiments.constant';
import { INodeRepository } from '../repositories/node.repository';
import { ExperimentsQueueProducer } from '../processors/experiments.producer';
import { TrashService } from './trash.service';

export interface TrashPurgeResult {
  purgedCount: number;
  reclaimedBytes: bigint;
  errors: number;
}

@Injectable()
export class TrashRetentionJob {
  private readonly logger = new Logger(TrashRetentionJob.name);

  constructor(
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    private readonly trashService: TrashService,
  ) {}

  async processExpiredTrash(retentionDays = 30): Promise<TrashPurgeResult> {
    const expiredNodes = await this.nodeRepo.findExpiredTrash(
      retentionDays,
      500,
    );
    let purgedCount = 0;
    let reclaimedBytes = 0n;
    let errors = 0;

    const processedIds = new Set<string>();

    for (const node of expiredNodes) {
      if (processedIds.has(node.id)) continue;

      try {
        const result = await this.trashService.purgeNodeAndSubtree(
          node,
          processedIds,
        );
        purgedCount += result.purgedCount;
        reclaimedBytes += result.reclaimedBytes;
      } catch (err: unknown) {
        errors++;
        this.logger.error(
          `Failed to purge expired trash node ${node.id}: ${(err as Error)?.message}`,
        );
      }
    }

    if (purgedCount > 0) {
      this.logger.log(
        `TrashRetentionJob purged ${purgedCount} expired items (older than ${retentionDays} days), reclaimed ${reclaimedBytes} bytes of storage quota`,
      );
    }
    return { purgedCount, reclaimedBytes, errors };
  }
}

@Injectable()
export class MultipartCleanupJob {
  private readonly logger = new Logger(MultipartCleanupJob.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(UPLOAD_SESSION_REPOSITORY)
    private readonly sessionRepo: ISessionRepository,
  ) {}

  async processExpiredSessions(): Promise<number> {
    const now = new Date();
    const expired = await this.sessionRepo.findExpiredSessions(now, 100);
    let abortedCount = 0;

    for (const session of expired) {
      try {
        await this.blobService.abortMultipartUpload(
          session.s3Key,
          session.s3UploadId,
        );
        session.markAborted();
        await this.sessionRepo.update(session);
        abortedCount++;
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to abort expired multipart session ${session.id}: ${(err as Error)?.message}`,
        );
      }
    }

    if (abortedCount > 0) {
      this.logger.log(
        `MultipartCleanupJob aborted ${abortedCount} abandoned multipart upload sessions`,
      );
    }
    return abortedCount;
  }
}

export const LEGACY_URL_BACKFILL_SQL = `
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT v.tbl, v.col
    FROM (VALUES
      ('attachments', 'url'),
      ('attachment_revisions', 'url'),
      ('library_items', 'url'),
      ('entity_attachments', 'url'),
      ('user_profiles', 'avatar_url'),
      ('user_profiles', 'cover_image_url'),
      ('projects', 'avatar'),
      ('project_templates', 'avatar'),
      ('conversations', 'avatar'),
      ('pages', 'pdf_thumbnail')
    ) AS v(tbl, col)
    JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = v.tbl
     AND c.column_name = v.col
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = replace(replace(replace(%I, ''/api/v1/storage/files/'', ''/api/v1/experiments/files/''), ''/api/v1/core/storage/local-'', ''/api/v1/files/local-''), ''/api/v1/storage/local-'', ''/api/v1/files/local-'') WHERE %I LIKE ''%%/api/v1/storage/%%'' OR %I LIKE ''%%/api/v1/core/storage/%%''',
      rec.tbl, rec.col, rec.col, rec.col, rec.col
    );
  END LOOP;

  FOR rec IN
    SELECT v.tbl, v.col
    FROM (VALUES
      ('storage_files', 'metadata'),
      ('attachments', 'metadata'),
      ('library_items', 'metadata'),
      ('entity_attachments', 'metadata'),
      ('work_item_comments', 'attachments'),
      ('messages', 'attachments')
    ) AS v(tbl, col)
    JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = v.tbl
     AND c.column_name = v.col
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = replace(replace(replace(%I::text, ''/api/v1/storage/files/'', ''/api/v1/experiments/files/''), ''/api/v1/core/storage/local-'', ''/api/v1/files/local-''), ''/api/v1/storage/local-'', ''/api/v1/files/local-'')::jsonb WHERE %I IS NOT NULL AND (%I::text LIKE ''%%/api/v1/storage/%%'' OR %I::text LIKE ''%%/api/v1/core/storage/%%'')',
      rec.tbl, rec.col, rec.col, rec.col, rec.col, rec.col
    );
  END LOOP;
END $$;
`;

@Injectable()
export class ExperimentsLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExperimentsLifecycleService.name);

  constructor(
    private readonly blobService: BlobService,
    private readonly queueProducer: ExperimentsQueueProducer,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (
      process.env.EXPERIMENTS_BOOTSTRAP_LIFECYCLE === 'false' ||
      (process.env.NODE_ENV === 'production' && !shouldRunWorkerConsumers())
    ) {
      this.logger.debug(
        'Skipping Experiments Lifecycle bootstrap on non-worker API replica',
      );
      return;
    }

    this.logger.log(
      'Initializing Experiments Lifecycle & Maintenance subsystem...',
    );

    await this.backfillLegacyUrls();
    await this.initializeBucketLifecycle();
    await this.queueProducer.scheduleMaintenanceJobs();
  }

  async backfillLegacyUrls(): Promise<void> {
    if (!this.prisma?.$executeRawUnsafe) {
      return;
    }
    try {
      await this.prisma.$executeRawUnsafe(LEGACY_URL_BACKFILL_SQL);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to run legacy URL backfill: ${(err as Error)?.message}`,
      );
    }
  }

  async initializeBucketLifecycle(
    config?: StorageLifecycleConfiguration,
  ): Promise<void> {
    try {
      await this.blobService.applyLifecycleRules(config);
      this.logger.log(
        'Bucket lifecycle configuration initialized successfully',
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to initialize bucket lifecycle rules: ${(err as Error)?.message}`,
      );
    }
  }
}

