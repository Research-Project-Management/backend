import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ChatService } from '../services/chat.service';
import { ChatGateway } from '../gateways/chat.gateway';
import {
  CreateDirectConversationDto,
  CreateGroupConversationDto,
  SendMessageDto,
  AddReactionDto,
  GetMessagesQueryDto,
} from '../dto/chat.dto';

@ApiTags('Chat')
@ApiBearerAuth('JWT-auth')
@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get('conversations')
  async getConversations(@CurrentUser('id') userId: string) {
    return this.chatService.getUserConversations(userId);
  }

  @Post('conversations/direct')
  async createDirect(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateDirectConversationDto,
  ) {
    return this.chatService.getOrCreateDirect(userId, dto.targetUserId);
  }

  @Post('conversations/group')
  async createGroup(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateGroupConversationDto,
  ) {
    return this.chatService.createGroup(userId, dto);
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Query() query: GetMessagesQueryDto,
  ) {
    const limit = query.limit ? parseInt(query.limit, 10) : 25;
    return this.chatService.getMessages(
      conversationId,
      userId,
      query.cursor,
      limit,
    );
  }

  @Post('conversations/:id/messages')
  async sendMessage(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SendMessageDto,
  ) {
    const message = await this.chatService.sendMessage(
      conversationId,
      userId,
      dto,
    );
    this.chatGateway.broadcastMessage(conversationId, message);
    return message;
  }

  @Post('conversations/:id/read')
  async markRead(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.markAsRead(conversationId, userId);
  }

  @Post('messages/:id/reactions')
  async addReaction(
    @Param('id') messageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReactionDto,
  ) {
    const res = await this.chatService.addReaction(
      messageId,
      userId,
      dto.emoji,
    );
    return res;
  }

  @Delete('messages/:id/reactions/:emoji')
  async removeReaction(
    @Param('id') messageId: string,
    @Param('emoji') emoji: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.removeReaction(messageId, userId, emoji);
  }
}
