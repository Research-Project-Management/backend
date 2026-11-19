import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CacheModule,
  shouldMountExperimentsControllers,
  shouldMountTransferControllers,
  shouldRunWorkerConsumers,
} from '@/core';
import { FilesModule } from '@/modules/files';
import {
  EXPERIMENT_NODE_REPOSITORY,
  EXPERIMENT_VERSION_REPOSITORY,
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
import { MultipartService } from './services/multipart.service';
import { StreamService } from './services/stream.service';
import { ExperimentsBackupService } from './services/backup.service';
import {
  ExperimentsLifecycleService,
  MultipartCleanupJob,
  TrashRetentionJob,
} from './services/lifecycle.service';
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

@Global()
@Module({
  imports: [
    CacheModule,
    FilesModule,
    BullModule.registerQueue({
      name: EXPERIMENTS_PROCESSING_QUEUE,
    }),
  ],
  controllers: [...experimentControllers, ...transferControllers],
  providers: [
    {
      provide: EXPERIMENT_NODE_REPOSITORY,
      useClass: NodeRepository,
    },
    {
      provide: EXPERIMENT_VERSION_REPOSITORY,
      useClass: VersionRepository,
    },
    ExperimentsAccessPolicy,
    ExperimentsCacheService,
    ExperimentsService,
    TrashService,
    VersionService,
    UploadService,
    MultipartService,
    StreamService,
    ExperimentsBackupService,
    ExperimentsQueueProducer,
    ...workerProviders,
    ExperimentsLifecycleService,
    ExperimentsEventListener,
    TrashRetentionJob,
    MultipartCleanupJob,
    ExperimentsFacade,
    {
      provide: EXPERIMENTS_PORT,
      useExisting: ExperimentsFacade,
    },
  ],
  exports: [
    EXPERIMENT_NODE_REPOSITORY,
    EXPERIMENT_VERSION_REPOSITORY,
    ExperimentsAccessPolicy,
    ExperimentsCacheService,
    ExperimentsService,
    TrashService,
    VersionService,
    UploadService,
    MultipartService,
    StreamService,
    ExperimentsBackupService,
    ExperimentsQueueProducer,
    ExperimentsLifecycleService,
    ExperimentsEventListener,
    ExperimentsFacade,
    EXPERIMENTS_PORT,
  ],
})
export class ExperimentsModule {}
