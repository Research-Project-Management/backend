import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { RagAgentController } from './rag-agent.controller';
import { RagAgentService } from './rag-agent.service';
import { ItemsModule as CatalogModule } from '@/modules/library/items/items.module';

@Module({
  imports: [EngineModule, CatalogModule],
  controllers: [RagAgentController],
  providers: [RagAgentService],
  exports: [RagAgentService],
})
export class RagAgentModule {}
