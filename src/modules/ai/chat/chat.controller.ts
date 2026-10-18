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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import {
  CreateChatDto,
  AppendMessagesDto,
  RenameChatDto,
} from './dto/chat.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';

@ApiTags('AI - Chats')
@ApiBearerAuth('JWT-auth')
@Controller(['api/ai/chats', 'ai/chats'])
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  @ApiOperation({ summary: 'Get all chat sessions for user' })
  async getChats(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    const chats = await this.chatService.getChats(userId, projectId);
    return { chats };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new AI chat session' })
  async createChat(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateChatDto,
  ) {
    return this.chatService.createChat(userId, dto);
  }

  @Get('page/:pageId')
  @ApiOperation({
    summary: 'Get active AI chat session for a specific document page',
  })
  async getPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.getPageChat(pageId, userId);
  }

  @Delete('page/:pageId')
  @ApiOperation({
    summary: 'Clear AI chat session for a specific document page',
  })
  async clearPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.clearPageChat(pageId, userId);
  }

  @Delete(['memory/:scopeId', 'memory'])
  @ApiOperation({ summary: 'Clear AI chat memory for user' })
  async clearMemory(
    @CurrentUser('id') userId: string,
    @Param('scopeId') scopeId?: string,
  ) {
    return this.chatService.clearMemory(userId, scopeId);
  }

  @Get(':chatId')
  @ApiOperation({
    summary: 'Get details and message history of a chat session',
  })
  async getChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.getChat(chatId, userId);
  }

  @Get(':chatId/messages')
  @ApiOperation({ summary: 'Get paginated messages of a chat session' })
  async getChatMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    const chat = await this.chatService.getChat(chatId, userId);
    const messages = chat.messages || [];
    const s = Number(skip) || 0;
    const l = Number(limit) || messages.length;
    return {
      messages: messages.slice(s, s + l),
      total: messages.length,
    };
  }

  @Post(':chatId/messages')
  @Patch(':chatId/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append messages to an existing chat session' })
  async appendMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AppendMessagesDto,
  ) {
    return this.chatService.appendMessages(chatId, userId, dto);
  }

  @Patch([':chatId', ':chatId/title'])
  @ApiOperation({ summary: 'Rename an AI chat session' })
  async renameChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RenameChatDto,
  ) {
    return this.chatService.renameChat(chatId, userId, dto);
  }

  @Delete(':chatId')
  @ApiOperation({ summary: 'Delete an AI chat session' })
  async deleteChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.deleteChat(chatId, userId);
  }
}

