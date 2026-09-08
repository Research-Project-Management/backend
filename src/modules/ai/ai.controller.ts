import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotImplementedException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AiService } from './ai.service';
import { AiQueryDto } from './dto/ai.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { Public } from '@/modules/iam/authn/decorators/public.decorator';
import { BypassEnvelope } from '@/core/decorators/bypass-envelope.decorator';

@ApiTags('AI - Unified Copilot')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'AI service health check' })
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const status = await this.aiService.health();
    if (status.status !== 'ok') {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return status;
  }

  /**
   * Unified Streaming AI execution endpoint.
   * Route aliases support all legacy endpoints: chat, chat/rag, editor-chat, chat/writing, chat/project
   */
  @Post([
    'chat',
    'chat/rag',
    'rag/chat',
    'editor-chat',
    'chat/writing',
    'writing/chat',
    'chat/project',
    'project/chat',
  ])
  @BypassEnvelope()
  @ApiOperation({
    summary: 'Stream unified AI Copilot execution responses via SSE',
  })
  async stream(
    @CurrentUser('id') userId: string,
    @Body() dto: AiQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.aiService.stream(userId, dto, reply);
  }

  /**
   * Unified Synchronous AI execution endpoint.
   */
  @Post([
    'chat/sync',
    'chat/rag/sync',
    'rag/chat/sync',
    'editor-chat/sync',
    'chat/writing/sync',
    'writing/chat/sync',
    'chat/project/sync',
    'project/chat/sync',
  ])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous AI Copilot query' })
  async execute(@CurrentUser('id') userId: string, @Body() dto: AiQueryDto) {
    return this.aiService.execute(userId, dto);
  }

  /**
   * Paper-scoped streaming RAG query
   */
  @Post([
    'paper/:paperId/chat',
    'rag/papers/:paperId/stream',
    'papers/:paperId/stream',
    'papers/:paperId/chat',
  ])
  @BypassEnvelope()
  @ApiOperation({ summary: 'Stream paper-scoped RAG responses via SSE' })
  async streamPaper(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: AiQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.aiService.streamPaper(userId, paperId, dto, reply);
  }

  /**
   * Paper-scoped synchronous RAG query
   */
  @Post(['papers/:paperId/chat/sync', 'paper/:paperId/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous paper-scoped RAG query' })
  async executePaper(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: AiQueryDto,
  ) {
    return this.aiService.executePaper(userId, paperId, dto);
  }

  /**
   * Document upload to Vector Store (Disabled due to lack of multi-tenant isolation in upstream FLux-AI)
   */
  @Post('documents/upload')
  @ApiOperation({
    summary: 'Upload document to AI engine vector store (Disabled)',
  })
  async uploadDocument() {
    throw new NotImplementedException(
      'Document vector upload is currently disabled due to lack of multi-tenant isolation in upstream AI engine.',
    );
  }

  @Post('documents/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk retrieve document details by IDs (Disabled)' })
  async getDocumentsBulk() {
    throw new NotImplementedException(
      'Document vector bulk retrieval is currently disabled due to lack of multi-tenant isolation in upstream AI engine.',
    );
  }

  @Get('documents')
  @ApiOperation({
    summary: 'List all RAG documents in vector store (Disabled)',
  })
  async getDocuments() {
    throw new NotImplementedException(
      'Document vector listing is currently disabled due to lack of multi-tenant isolation in upstream AI engine.',
    );
  }

  @Get(['documents/:docId', 'documents/:docId/content'])
  @ApiOperation({
    summary: 'Get document details or text content from AI engine (Disabled)',
  })
  async getDocument(@Param('docId') _docId: string) {
    throw new NotImplementedException(
      'Document vector retrieval is currently disabled due to lack of multi-tenant isolation in upstream AI engine.',
    );
  }
}
