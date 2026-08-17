import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { WritingAgentController } from './writing-agent.controller';
import { WritingAgentService } from './writing-agent.service';

@Module({
  imports: [EngineModule],
  controllers: [WritingAgentController],
  providers: [WritingAgentService],
  exports: [WritingAgentService],
})
export class WritingAgentModule {}
