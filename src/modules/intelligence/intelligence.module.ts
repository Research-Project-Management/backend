import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { ChatHistoryModule } from './chat-history/chat-history.module';

@Module({
  imports: [AiModule, ChatHistoryModule],
  exports: [AiModule, ChatHistoryModule],
})
export class IntelligenceModule {}
