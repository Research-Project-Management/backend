import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { BypassEnvelope } from '@/core';
import {
  CurrentUser,
  JwtAuthGuard,
  Public,
  VerifiedEmailGuard,
} from '@/modules/identity/auth';
import { AI_ENGINE_PORT } from '../../ai.constant';
import type { IAiEnginePort } from '../../engine/engine.port';
import { QueryDto, ResumeDto } from '../dto/query.dto';
import { ChatService } from '../services/chat.service';
import { SessionService } from '../services/session.service';

@ApiTags('AI - Chat')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly sessionService: SessionService,
    @Inject(AI_ENGINE_PORT)
    private readonly engine: IAiEnginePort,
  ) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'AI service health check' })
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const status = await this.engine.health();
    if (status.status !== 'ok') {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return status;
  }

  @Get('agents')
  @ApiOperation({ summary: 'List registered specialist AI agents' })
  async listAgents() {
    const agents = await this.engine.listAgents();
    return { agents };
  }

  @Post(['chat', 'editor-chat'])
  @UseGuards(VerifiedEmailGuard)
  @BypassEnvelope()
  @ApiOperation({ summary: 'Stream unified AI execution via SSE' })
  async stream(
    @CurrentUser('id') userId: string,
    @Body() dto: QueryDto,
    @Res() reply: FastifyReply,
    @Headers('authorization') authorization?: string,
  ) {
    return this.chatService.stream(userId, dto, reply, authorization);
  }

  @Post(['chat/sync', 'editor-chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous unified AI execution' })
  async execute(
    @CurrentUser('id') userId: string,
    @Body() dto: QueryDto,
    @Headers('authorization') authorization?: string,
  ) {
    return this.chatService.execute(userId, dto, authorization);
  }

  @Post('chat/resume')
  @UseGuards(VerifiedEmailGuard)
  @BypassEnvelope()
  @ApiOperation({ summary: 'Resume interrupted HITL run via SSE' })
  async resumeStream(
    @CurrentUser('id') userId: string,
    @Body() dto: ResumeDto,
    @Res() reply: FastifyReply,
    @Headers('authorization') authorization?: string,
  ) {
    return this.chatService.resumeStream(userId, dto, reply, authorization);
  }

  @Post('chat/resume/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume interrupted HITL run synchronously' })
  async resumeSync(
    @CurrentUser('id') userId: string,
    @Body() dto: ResumeDto,
    @Headers('authorization') authorization?: string,
  ) {
    return this.chatService.resumeSync(userId, dto, authorization);
  }

  @Post('chat/:chatId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an active AI generation stream' })
  async cancel(
    @CurrentUser('id') userId: string,
    @Param('chatId') chatId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.chatService.cancel(userId, chatId, spaceId);
  }

  @Post('turns/:traceId/revert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revert mutations recorded for an AI turn' })
  async revertTurn(
    @CurrentUser('id') userId: string,
    @Param('traceId') traceId: string,
    @Query('spaceId') spaceId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.chatService.revertTurn(userId, traceId, spaceId, authorization);
  }

  @Delete(['memory/:spaceId', 'memory'])
  @ApiOperation({ summary: 'Clear AI chat memory for user in space' })
  async clearMemory(
    @CurrentUser('id') userId: string,
    @Param('spaceId') spaceId?: string,
  ) {
    return this.sessionService.clearMemory(userId, spaceId);
  }
}
