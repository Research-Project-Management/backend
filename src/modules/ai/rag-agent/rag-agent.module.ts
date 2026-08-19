import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { RagAgentController } from './rag-agent.controller';
import { RagAgentService } from './rag-agent.service';
import { PaperModule } from '@/modules/library/paper/paper.module';

@Module({
  imports: [EngineModule, PaperModule],
  controllers: [RagAgentController],
  providers: [RagAgentService],
  exports: [RagAgentService],
})
export class RagAgentModule {}
