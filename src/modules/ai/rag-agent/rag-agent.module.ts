import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { RagAgentController } from './rag-agent.controller';
import { RagAgentService } from './rag-agent.service';

@Module({
  imports: [EngineModule],
  controllers: [RagAgentController],
  providers: [RagAgentService],
  exports: [RagAgentService],
})
export class RagAgentModule {}
