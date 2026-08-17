import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { ThreadModule } from '../thread/thread.module';
import { ProjectAgentController } from './project-agent.controller';
import { ProjectAgentService } from './project-agent.service';

@Module({
  imports: [EngineModule, ThreadModule],
  controllers: [ProjectAgentController],
  providers: [ProjectAgentService],
  exports: [ProjectAgentService],
})
export class ProjectAgentModule {}
