import { Module } from '@nestjs/common';
import { VerifiedEmailGuard } from '@/modules/identity/auth';
import { AccessModule } from '../access/access.module';
import { EngineModule } from '../engine/engine.module';
import { ChatRepository } from './chat.repository';
import { ChatController } from './controllers/chat.controller';
import { PaperController } from './controllers/paper.controller';
import { SessionController } from './controllers/session.controller';
import { ChatService } from './services/chat.service';
import { PaperChatService } from './services/paper.service';
import { SessionService } from './services/session.service';
import { TitleService } from './services/title.service';

@Module({
  imports: [EngineModule, AccessModule],
  controllers: [ChatController, PaperController, SessionController],
  providers: [
    ChatRepository,
    SessionService,
    TitleService,
    ChatService,
    PaperChatService,
    VerifiedEmailGuard,
  ],
  exports: [ChatService, SessionService, PaperChatService],
})
export class ChatModule {}
