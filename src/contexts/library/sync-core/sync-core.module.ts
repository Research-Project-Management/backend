import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { ChangeLogRepository } from './change-log.repository';
import { IdempotencyRepository } from './idempotency.repository';
import { LibraryTransactionService } from './library-transaction.service';
import { OutboxWorker } from './outbox.worker';
import { SyncMetricsService } from './sync.metrics';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SyncController],
  providers: [
    ChangeLogRepository,
    IdempotencyRepository,
    LibraryTransactionService,
    OutboxWorker,
    SyncMetricsService,
  ],
  exports: [
    ChangeLogRepository,
    IdempotencyRepository,
    LibraryTransactionService,
    OutboxWorker,
    SyncMetricsService,
  ],
})
export class SyncCoreContextModule {}
