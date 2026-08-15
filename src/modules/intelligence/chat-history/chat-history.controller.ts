import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ChatHistoryService } from './chat-history.service';
import {
  CreateChatDto,
  AppendMessagesDto,
  RenameChatDto,
} from './dto/chat-history.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Intelligence')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ChatHistoryController {
  constructor(private readonly chatHistoryService: ChatHistoryService) {}

  @Get('chats')
  async getChats(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    const chats = await this.chatHistoryService.getChats(workspaceId, userId);
    return { chats };
  }

  @Post('chats')
  @HttpCode(HttpStatus.CREATED)
  async createChat(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateChatDto,
  ) {
    const chat = await this.chatHistoryService.createChat(userId, dto);
    return { chat };
  }

  @Get('chats/page/:pageId')
  async getPageChat(
    @Param('pageId') pageId: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    const chat = await this.chatHistoryService.getPageChat(
      pageId,
      workspaceId,
      userId,
    );
    return { chat };
  }

  @Delete('chats/page/:pageId')
  async clearPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatHistoryService.clearPageChat(pageId, userId);
  }

  @Get('chats/:chatId')
  async getChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    const chat = await this.chatHistoryService.getChat(chatId, userId);
    return { chat };
  }

  @Patch('chats/:chatId/messages')
  async appendMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AppendMessagesDto,
  ) {
    const chat = await this.chatHistoryService.appendMessages(
      chatId,
      userId,
      dto,
    );
    return { chat };
  }

  @Patch('chats/:chatId/title')
  async renameChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RenameChatDto,
  ) {
    const chat = await this.chatHistoryService.renameChat(chatId, userId, dto);
    return { chat };
  }

  @Delete('chats/:chatId')
  async deleteChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatHistoryService.deleteChat(chatId, userId);
  }

  @Delete('memory/clear')
  async clearMemory(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatHistoryService.clearMemory(workspaceId, userId);
  }
}
