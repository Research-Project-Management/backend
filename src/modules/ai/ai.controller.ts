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
import '@fastify/multipart';
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
   * Document upload to Vector Store with multi-tenant isolation
   */
  @Post('documents/upload')
  @ApiOperation({
    summary:
      'Upload document to AI engine vector store with multi-tenant isolation',
  })
  async uploadDocument(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    const fastifyReq = req as any;
    if (!fastifyReq.isMultipart?.() && !fastifyReq.isMultipart) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const parts = fastifyReq.parts();
    let buffer: Buffer | null = null;
    let filename = 'document';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, any> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename;
        mimeType = part.mimetype;
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    if (!buffer) {
      throw new BadRequestException('File is required');
    }

    const workspaceId = fields.workspaceId || fields.workspace_id;
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }

    const projectId = fields.projectId || fields.project_id;
    const title = fields.title;
    const tags = fields.tags;
    const chatId = fields.chatId || fields.chat_id;

    return this.aiService.uploadDocument(
      userId,
      String(workspaceId),
      buffer,
      mimeType,
      filename,
      {
        projectId: projectId ? String(projectId) : undefined,
        chatId: chatId ? String(chatId) : undefined,
        title: title ? String(title) : undefined,
        tags: tags ? String(tags) : undefined,
      },
    );
  }

  @Post('documents/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk retrieve document details by IDs' })
  async getDocumentsBulk(
    @CurrentUser('id') userId: string,
    @Body() body: { ids: string[]; workspaceId: string },
  ) {
    if (!body?.workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    return this.aiService.getDocumentsBulk(
      userId,
      body.workspaceId,
      body.ids || [],
    );
  }

  @Get('documents')
  @ApiOperation({
    summary: 'List all RAG documents in workspace vector store',
  })
  async getDocuments(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    const query = req.query as Record<string, string>;
    const workspaceId = query?.workspaceId || query?.workspace_id;
    if (!workspaceId) {
      throw new BadRequestException('workspaceId query parameter is required');
    }
    return this.aiService.getDocuments(userId, workspaceId);
  }

  @Get(['documents/:docId', 'documents/:docId/content'])
  @ApiOperation({
    summary: 'Get document details from workspace vector store',
  })
  async getDocument(
    @CurrentUser('id') userId: string,
    @Param('docId') docId: string,
    @Req() req: FastifyRequest,
  ) {
    const query = req.query as Record<string, string>;
    const workspaceId = query?.workspaceId || query?.workspace_id;
    if (!workspaceId) {
      throw new BadRequestException('workspaceId query parameter is required');
    }
    return this.aiService.getDocument(userId, workspaceId, docId);
  }
}
