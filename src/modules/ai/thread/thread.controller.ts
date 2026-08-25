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
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';

@ApiTags('AI - Threads')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ThreadController {
  constructor(private readonly threadService: ThreadService) {}

  @Get(['chats', 'ai/chats'])
  @ApiOperation({ summary: 'Get all chat threads for user in workspace' })
  async getChats(
    @Query('workspaceId') workspaceId: string,
    @Query('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    const chats = await this.threadService.getChats(
      workspaceId,
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
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.getPageChat(pageId, workspaceId, userId);
  }

  @Delete(['chats/page/:pageId', 'ai/page-chats/:pageId', 'page-chats/:pageId'])
  @ApiOperation({
    summary: 'Clear AI chat thread for a specific document page',
  })
  async clearPageChat(
    @Param('pageId') pageId: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.clearPageChat(pageId, workspaceId, userId);
  }

  @Delete(['ai/memory/:workspaceId', 'memory/:workspaceId', 'memory/clear'])
  @ApiOperation({ summary: 'Clear AI chat memory for user in workspace' })
  async clearMemory(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.clearMemory(workspaceId, userId);
  }

  @Get(['chats/:chatId', 'ai/chats/:chatId'])
  @ApiOperation({ summary: 'Get details and message history of a chat thread' })
  async getChat(@Param('chatId') chatId: string) {
    const chat = await this.threadService.getChat(chatId);
    return chat;
  }

  @Post(['chats/:chatId/messages', 'ai/chats/:chatId/messages'])
  @Patch(['chats/:chatId/messages', 'ai/chats/:chatId/messages'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append messages to an existing chat thread' })
  async appendMessages(
    @Param('chatId') chatId: string,
    @Body() dto: AppendMessagesDto,
  ) {
    const chat = await this.threadService.appendMessages(chatId, dto);
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
    @Body() dto: RenameThreadDto,
  ) {
    const chat = await this.threadService.renameChat(chatId, dto);
    return chat;
  }

  @Delete(['chats/:chatId', 'ai/chats/:chatId'])
  @ApiOperation({ summary: 'Delete an AI chat thread' })
  async deleteChat(@Param('chatId') chatId: string) {
    return this.threadService.deleteChat(chatId);
  }
}
