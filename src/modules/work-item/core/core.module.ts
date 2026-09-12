import { Module } from '@nestjs/common';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';
import { CoreRepository } from './core.repository';
import { IdHandler } from './handlers/id.handler';
import { RankHandler } from './handlers/rank.handler';
import { CloneHandler } from './handlers/clone.handler';
import { EventDispatcher } from './handlers/event.dispatcher';

@Module({
  controllers: [CoreController],
  providers: [
    CoreService,
    CoreRepository,
    IdHandler,
    RankHandler,
    CloneHandler,
    EventDispatcher,
  ],
  exports: [
    CoreService,
    CoreRepository,
    IdHandler,
    RankHandler,
    CloneHandler,
    EventDispatcher,
  ],
})
export class CoreModule {}
