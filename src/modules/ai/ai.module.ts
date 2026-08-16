import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { ThreadModule } from './thread/thread.module';

@Module({
  imports: [ChatModule, ThreadModule],
  exports: [ChatModule, ThreadModule],
})
export class AiModule {}
