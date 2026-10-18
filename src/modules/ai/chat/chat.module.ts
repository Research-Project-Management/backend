import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatController } from './chat.controller';
import { EngineModule } from '../engine/engine.module';

@Module({
  imports: [EngineModule],
  controllers: [ChatController],
  providers: [ChatService, ChatRepository],
  exports: [ChatService, ChatRepository],
})
export class ChatModule {}

