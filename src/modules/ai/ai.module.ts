import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { ThreadModule } from './thread/thread.module';
import { ProjectAgentModule } from './project-agent/project-agent.module';
import { RagAgentModule } from './rag-agent/rag-agent.module';
import { WritingAgentModule } from './writing-agent/writing-agent.module';
import { AiHealthController } from './ai-health.controller';

@Module({
  imports: [
    EngineModule,
    ThreadModule,
    ProjectAgentModule,
    RagAgentModule,
    WritingAgentModule,
  ],
  controllers: [AiHealthController],
  exports: [
    EngineModule,
    ThreadModule,
    ProjectAgentModule,
    RagAgentModule,
    WritingAgentModule,
  ],
})
export class AiModule {}
