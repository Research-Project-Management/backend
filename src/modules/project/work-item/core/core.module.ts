import { Module } from '@nestjs/common';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';
import { CoreRepository } from './core.repository';
import { IdHandler } from './handlers/id.handler';
import { RankHandler } from './handlers/rank.handler';
import { CloneHandler } from './handlers/clone.handler';
import { EventHandler } from './handlers/event.handler';
import { SyncHandler } from './handlers/sync.handler';
import { BulkHandler } from './handlers/bulk.handler';

@Module({
  controllers: [CoreController],
  providers: [
    CoreService,
    CoreRepository,
    IdHandler,
    RankHandler,
    CloneHandler,
    EventHandler,
    SyncHandler,
    BulkHandler,
  ],
  exports: [
    CoreService,
    CoreRepository,
    IdHandler,
    RankHandler,
    CloneHandler,
    EventHandler,
    SyncHandler,
    BulkHandler,
  ],
})
export class CoreModule {}
