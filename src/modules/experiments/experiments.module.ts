import { Module } from '@nestjs/common';
import {
  RedisModule,
  shouldMountExperimentsControllers,
  shouldMountTransferControllers,
} from '@/core';
import { FilesModule } from '@/modules/files';
import { EXPERIMENTS_PORT } from './experiments.constant';
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

@Module({
  imports: [RedisModule, FilesModule],
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
