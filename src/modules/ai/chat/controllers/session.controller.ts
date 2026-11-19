import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  AppendMessagesDto,
  CreateSessionDto,
  RenameSessionDto,
} from '../dto/session.dto';
import { SessionService } from '../services/session.service';

@ApiTags('AI - Chats')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai/chats')
@UseGuards(JwtAuthGuard)
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Get()
  @ApiOperation({ summary: 'Get all chat sessions for user' })
  async getChats(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const chats = await this.sessionService.getChats(userId, spaceId);
    return { chats };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new AI chat session' })
  async createChat(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessionService.createChat(userId, dto);
  }

  @Get('page/:pageId')
  @ApiOperation({ summary: 'Get active AI chat session for a manuscript page' })
  async getPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionService.getPageChat(pageId, userId);
  }

  @Delete('page/:pageId')
  @ApiOperation({ summary: 'Clear AI chat session for a manuscript page' })
  async clearPageChat(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionService.clearPageChat(pageId, userId);
  }

  @Get(':chatId')
  @ApiOperation({ summary: 'Get details and messages of a chat session' })
  async getChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionService.getChat(chatId, userId);
  }

  @Get(':chatId/messages')
  @ApiOperation({ summary: 'Get paginated messages of a chat session' })
  async getChatMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    const chat = await this.sessionService.getChat(chatId, userId);
    const messages = chat.messages || [];
    const offset = Math.max(0, Number(skip) || 0);
    const count = Math.min(
      200,
      Math.max(1, Number(limit) || messages.length || 50),
    );
    return {
      messages: messages.slice(offset, offset + count),
      total: messages.length,
    };
  }

  @Post(':chatId/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append messages to an existing chat session' })
  async appendMessages(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AppendMessagesDto,
  ) {
    return this.sessionService.appendMessages(chatId, userId, dto);
  }

  @Patch(':chatId')
  @ApiOperation({ summary: 'Rename an AI chat session' })
  async renameChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RenameSessionDto,
  ) {
    return this.sessionService.renameChat(chatId, userId, dto);
  }

  @Delete(':chatId')
  @ApiOperation({ summary: 'Delete an AI chat session' })
  async deleteChat(
    @Param('chatId') chatId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionService.deleteChat(chatId, userId);
  }
}
