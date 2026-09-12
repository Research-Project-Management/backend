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
import { ThreadService } from './thread.service';
import {
  CreateThreadDto,
  AppendMessagesDto,
  RenameThreadDto,
} from './dto/thread.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';

@ApiTags('AI - Threads')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ThreadController {
  constructor(private readonly threadService: ThreadService) {}

  @Get(['chats', 'ai/chats'])
  @ApiOperation({ summary: 'Get all chat threads for user' })
  async getChats(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    const chats = await this.threadService.getChats(
      userId,
      projectId,
    );
    return { chats };
  }

  @Post(['chats', 'ai/chats'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new AI chat thread' })
  async createChat(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateThreadDto,
  ) {
    const chat = await this.threadService.createChat(userId, dto);
    return chat;
  }

  @Get(['chats/page/:pageId', 'ai/page-chats/:pageId', 'page-chats/:pageId'])
  @ApiOperation({
    summary: 'Get active AI chat thread for a specific document page',
  })
  async getPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.getPageChat(pageId, userId);
  }

  @Delete(['chats/page/:pageId', 'ai/page-chats/:pageId', 'page-chats/:pageId'])
  @ApiOperation({
    summary: 'Clear AI chat thread for a specific document page',
  })
  async clearPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.clearPageChat(pageId, userId);
  }

  @Delete([
    'ai/memory/:scopeId',
    'memory/:scopeId',
    'ai/memory',
    'memory',
    'memory/clear',
  ])
  @ApiOperation({ summary: 'Clear AI chat memory for user' })
  async clearMemory(
    @CurrentUser('id') userId: string,
    @Param('scopeId') scopeId?: string,
  ) {
    return this.threadService.clearMemory(userId, scopeId);
  }

  @Get(['chats/:chatId', 'ai/chats/:chatId'])
  @ApiOperation({ summary: 'Get details and message history of a chat thread' })
  async getChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    const chat = await this.threadService.getChat(chatId, userId);
    return chat;
  }

  @Get(['chats/:chatId/messages', 'ai/chats/:chatId/messages'])
  @ApiOperation({ summary: 'Get paginated messages of a chat thread' })
  async getChatMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    const chat = await this.threadService.getChat(chatId, userId);
    const messages = chat.messages || [];
    const s = Number(skip) || 0;
    const l = Number(limit) || messages.length;
    return {
      messages: messages.slice(s, s + l),
      total: messages.length,
    };
  }

  @Post(['chats/:chatId/messages', 'ai/chats/:chatId/messages'])
  @Patch(['chats/:chatId/messages', 'ai/chats/:chatId/messages'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append messages to an existing chat thread' })
  async appendMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AppendMessagesDto,
  ) {
    const chat = await this.threadService.appendMessages(chatId, userId, dto);
    return chat;
  }

  @Patch([
    'chats/:chatId',
    'ai/chats/:chatId',
    'chats/:chatId/title',
    'ai/chats/:chatId/title',
  ])
  @ApiOperation({ summary: 'Rename an AI chat thread' })
  async renameChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RenameThreadDto,
  ) {
    const chat = await this.threadService.renameChat(chatId, userId, dto);
    return chat;
  }

  @Delete(['chats/:chatId', 'ai/chats/:chatId'])
  @ApiOperation({ summary: 'Delete an AI chat thread' })
  async deleteChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.deleteChat(chatId, userId);
  }
}
