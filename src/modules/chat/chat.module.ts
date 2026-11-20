import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtimeCoreModule } from '@/modules/realtime';
import { FilesModule } from '@/modules/files/files.module';

// Controllers
import { ChatController } from './controllers/chat.controller';
import { ProjectChatController } from './controllers/project-chat.controller';
import { FriendshipController } from './controllers/friendship.controller';

// Services
import { ChatService } from './services/chat.service';
import { ProjectChannelService } from './services/project-channel.service';
import { FriendshipService } from './services/friendship.service';
import { ChatCacheService } from './services/chat-cache.service';
import { ChatAttachmentService } from './services/chat-attachment.service';

// Realtime Gateway
import { ChatGateway } from './gateways/chat.gateway';

@Module({
  imports: [ConfigModule, RealtimeCoreModule, FilesModule],
  controllers: [ChatController, ProjectChatController, FriendshipController],
  providers: [
    ChatService,
    ProjectChannelService,
    FriendshipService,
    ChatCacheService,
    ChatAttachmentService,
    ChatGateway,
  ],
  exports: [
    ChatService,
    ProjectChannelService,
    FriendshipService,
    ChatCacheService,
    ChatAttachmentService,
  ],
})
export class ChatModule {}
