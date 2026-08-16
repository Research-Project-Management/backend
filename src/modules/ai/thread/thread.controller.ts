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
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('AI - Threads')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ThreadController {
  constructor(private readonly threadService: ThreadService) {}

  @Get('chats')
  @ApiOperation({ summary: 'Get all chat threads for user in workspace' })
  async getChats(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    const chats = await this.threadService.getChats(workspaceId, userId);
    return { chats };
  }

  @Post('chats')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new AI chat thread' })
  async createChat(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateThreadDto,
  ) {
    const chat = await this.threadService.createChat(userId, dto);
    return { chat };
  }

  @Get('chats/page/:pageId')
  @ApiOperation({ summary: 'Get active AI chat thread for a specific document page' })
  async getPageChat(
    @Param('pageId') pageId: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.threadService.getPageChat(pageId, workspaceId, userId);
  }

  @Get('chats/:chatId')
  @ApiOperation({ summary: 'Get details and message history of a chat thread' })
  async getChat(@Param('chatId') chatId: string) {
    return this.threadService.getChat(chatId);
  }

  @Post('chats/:chatId/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append messages to an existing chat thread' })
  async appendMessages(
    @Param('chatId') chatId: string,
    @Body() dto: AppendMessagesDto,
  ) {
    const chat = await this.threadService.appendMessages(chatId, dto);
    return { chat };
  }

  @Patch('chats/:chatId')
  @ApiOperation({ summary: 'Rename an AI chat thread' })
  async renameChat(
    @Param('chatId') chatId: string,
    @Body() dto: RenameThreadDto,
  ) {
    const chat = await this.threadService.renameChat(chatId, dto);
    return { chat };
  }

  @Delete('chats/:chatId')
  @ApiOperation({ summary: 'Delete an AI chat thread' })
  async deleteChat(@Param('chatId') chatId: string) {
    return this.threadService.deleteChat(chatId);
  }
}
