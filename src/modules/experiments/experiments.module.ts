import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  RedisModule,
  shouldMountExperimentsControllers,
  shouldMountTransferControllers,
  shouldRunWorkerConsumers,
} from '@/core';
import { FilesModule } from '@/modules/files';
import {
  EXPERIMENTS_PORT,
  EXPERIMENTS_PROCESSING_QUEUE,
} from './experiments.constant';
import { NodeRepository } from './repositories/node.repository';
import { VersionRepository } from './repositories/version.repository';
import { ExperimentsAccessPolicy } from './domain/access.policy';
import { ExperimentsCacheService } from './services/cache.service';
import { ExperimentsService } from './services/experiments.service';
import { TrashService } from './services/trash.service';
import { VersionService } from './services/version.service';
import { UploadService } from './services/upload.service';
import { StreamService } from './services/stream.service';
import { ExperimentsBackupService } from './services/backup.service';
import { ExperimentsQueueProducer } from './processors/experiments.producer';
import { ExperimentsQueueConsumer } from './processors/experiments.processor';
import { ExperimentsEventListener } from './processors/experiments.listener';
import { ExperimentsController } from './controllers/experiments.controller';
import { TrashController } from './controllers/trash.controller';
import { VersionController } from './controllers/version.controller';
import { UploadController } from './controllers/upload.controller';
import { StreamController } from './controllers/stream.controller';
import { ExperimentsFacade } from './experiments.facade';

const experimentControllers = shouldMountExperimentsControllers()
  ? [TrashController, ExperimentsController, VersionController]
  : [];

const transferControllers = shouldMountTransferControllers()
  ? [UploadController, StreamController]
  : [];

const workerProviders = shouldRunWorkerConsumers()
  ? [ExperimentsQueueConsumer]
  : [];

@Module({
  imports: [
    RedisModule,
    FilesModule,
    BullModule.registerQueue({
      name: EXPERIMENTS_PROCESSING_QUEUE,
    }),
  ],
  controllers: [...experimentControllers, ...transferControllers],
  providers: [
    NodeRepository,
    VersionRepository,
    ExperimentsAccessPolicy,
    ExperimentsCacheService,
    ExperimentsService,
    TrashService,
    VersionService,
    UploadService,
    StreamService,
    ExperimentsBackupService,
    ExperimentsQueueProducer,
    ...workerProviders,
    ExperimentsEventListener,
    ExperimentsFacade,
    {
      provide: EXPERIMENTS_PORT,
      useExisting: ExperimentsFacade,
    },
  ],
  exports: [ExperimentsFacade, EXPERIMENTS_PORT],
})
export class ExperimentsModule {}
