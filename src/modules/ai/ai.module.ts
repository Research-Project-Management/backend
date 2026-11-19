import { Module } from '@nestjs/common';
import { AI_FACADE } from './ai.constant';
import { AiFacade } from './ai.facade';
import { AccessModule } from './access/access.module';
import { ChatModule } from './chat/chat.module';
import { EngineModule } from './engine/engine.module';
import { KnowledgeModule } from './knowledge/knowledge.module';

@Module({
  imports: [EngineModule, AccessModule, ChatModule, KnowledgeModule],
  providers: [
    AiFacade,
    {
      provide: AI_FACADE,
      useExisting: AiFacade,
    },
  ],
  exports: [AiFacade, AI_FACADE],
})
export class AiModule {}
