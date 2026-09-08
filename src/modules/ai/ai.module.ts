import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { ThreadModule } from './thread/thread.module';
import { ItemsModule } from '../library/items/items.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports: [EngineModule, ThreadModule, ItemsModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService, EngineModule, ThreadModule],
})
export class AiModule {}
