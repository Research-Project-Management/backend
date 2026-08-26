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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { RagAgentService } from './rag-agent.service';
import { RagAgentQueryDto } from './dto/rag-agent.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { Public } from '@/modules/iam/authn/decorators/public.decorator';
import { BypassEnvelope } from '@/core/decorators/bypass-envelope.decorator';

@ApiTags('AI - RAG Agent')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class RagAgentController {
  constructor(private readonly ragAgentService: RagAgentService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'AI service health check' })
  health() {
    return {
      status: 'ok',
      service: 'flux-ai-engine',
      timestamp: new Date().toISOString(),
    };
  }

  @Post(['chat', 'chat/rag', 'rag/chat'])
  @BypassEnvelope()
  @ApiOperation({ summary: 'Stream RAG Agent chat responses via SSE' })
  async chatStream(
    @CurrentUser('id') userId: string,
    @Body() dto: RagAgentQueryDto,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.ragAgentService.streamRagChat(userId, dto, reply);
  }

  @Post(['chat/sync', 'chat/rag/sync', 'rag/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous RAG Agent chat' })
  async chatSync(
    @CurrentUser('id') userId: string,
    @Body() dto: RagAgentQueryDto,
  ) {
    return this.ragAgentService.syncRagChat(userId, dto);
  }

  @Post('paper/:paperId/chat')
  @ApiOperation({ summary: 'Stream paper-scoped RAG chat responses via SSE' })
  async paperChatStream(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: RagAgentQueryDto,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.ragAgentService.streamPaperChat(userId, paperId, dto, reply);
  }

  @Post('paper/:paperId/chat/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous paper-scoped RAG chat' })
  async paperChatSync(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: RagAgentQueryDto,
  ) {
    return this.ragAgentService.syncPaperChat(userId, paperId, dto);
  }

  @Get('documents')
  @ApiOperation({ summary: 'List all RAG documents' })
  async getDocuments() {
    return this.ragAgentService.getDocuments();
  }

  @Post('documents/upload')
  @ApiOperation({ summary: 'Upload document to RAG engine' })
  async uploadDocument(@Req() req: FastifyRequest) {
    const isMultipart = req.isMultipart && req.isMultipart();
    if (isMultipart) {
      const parts = (req as any).parts();
      let buffer: Buffer | null = null;
      let contentType = 'application/octet-stream';
      for await (const part of parts) {
        if (part.type === 'file') {
          contentType = part.mimetype;
          buffer = await part.toBuffer();
        }
      }
      if (!buffer) {
        throw new BadRequestException('No file provided in multipart request');
      }
      return this.ragAgentService.uploadDocument(buffer, contentType);
    }
    const rawBody = (req.body as Buffer) || Buffer.from('');
    return this.ragAgentService.uploadDocument(
      rawBody,
      req.headers['content-type'] || 'application/octet-stream',
    );
  }

  @Post('documents/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk retrieve document details by IDs' })
  async getDocumentsBulk(@Body() body: { ids?: string[] }) {
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    return this.ragAgentService.getDocumentsBulk(ids);
  }

  @Get(['documents/:docId', 'documents/:docId/content'])
  @ApiOperation({
    summary: 'Get document details or text content from RAG engine',
  })
  async getDocument(@Param('docId') docId: string) {
    const doc = await this.ragAgentService.getDocument(docId);
    if (!doc) {
      return { text: '', id: docId };
    }
    return {
      text: (doc.content as string) || (doc.text as string) || '',
      ...doc,
    };
  }
}
