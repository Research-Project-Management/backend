import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

// Controllers
import { ChatController } from './controllers/chat.controller';
import { ProjectChatController } from './controllers/project-chat.controller';
import { FriendshipController } from './controllers/friendship.controller';

// Services
import { ChatService } from './services/chat.service';
import { ProjectChannelService } from './services/project-channel.service';
import { FriendshipService } from './services/friendship.service';
import { ChatCacheService } from './services/chat-cache.service';

// Realtime Gateway
import { ChatGateway } from './gateways/chat.gateway';
import { WsAuthService } from '@/modules/realtime/core/ws-auth.guard';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [ChatController, ProjectChatController, FriendshipController],
  providers: [
    ChatService,
    ProjectChannelService,
    FriendshipService,
    ChatCacheService,
    ChatGateway,
    WsAuthService,
  ],
  exports: [
    ChatService,
    ProjectChannelService,
    FriendshipService,
    ChatCacheService,
  ],
})
export class ChatModule {}
