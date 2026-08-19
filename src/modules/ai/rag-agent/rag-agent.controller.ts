import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
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
import { RagAgentQueryDto, BulkDocumentsDto } from './dto/rag-agent.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';

@ApiTags('AI - RAG Agent')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class RagAgentController {
  constructor(private readonly ragAgentService: RagAgentService) {}

  @Post(['chat/rag', 'rag/chat'])
  @ApiOperation({ summary: 'Stream RAG Agent chat responses via SSE' })
  async chatStream(
    @CurrentUser('id') userId: string,
    @Body() dto: RagAgentQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.ragAgentService.streamRagChat(userId, dto, reply);
  }

  @Post(['chat/rag/sync', 'rag/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute synchronous RAG Agent query' })
  async chatSync(
    @CurrentUser('id') userId: string,
    @Body() dto: RagAgentQueryDto,
  ) {
    return this.ragAgentService.syncRagChat(userId, dto);
  }

  @Post('rag/papers/:paperId/stream')
  @ApiOperation({ summary: 'Stream AI Copilot RAG chat responses for a specific paper via SSE' })
  async streamPaperChat(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: RagAgentQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.ragAgentService.streamPaperChat(userId, paperId, dto, reply);
  }

  @Post('rag/papers/:paperId/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute synchronous AI Copilot RAG query for a specific paper' })
  async syncPaperChat(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: RagAgentQueryDto,
  ) {
    return this.ragAgentService.syncPaperChat(userId, paperId, dto);
  }

  @Post(['documents/upload', 'rag/documents/upload'])
  @ApiOperation({ summary: 'Upload reference document for AI RAG groundings' })
  async uploadDocument(@Req() req: FastifyRequest) {
    const isMultipart = req.isMultipart();
    if (!isMultipart) {
      throw new BadRequestException('Request must be multipart/form-data');
    }

    const file = await req.file();
    if (!file) {
      throw new BadRequestException('No file found in request');
    }

    const buffer = await file.toBuffer();
    const filename = file.filename || 'uploaded-doc';
    const mimetype = file.mimetype || 'application/octet-stream';

    const boundary =
      '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fullBuffer = Buffer.concat([prefix, buffer, suffix]);

    return this.ragAgentService.uploadDocument(
      fullBuffer,
      `multipart/form-data; boundary=${boundary}`,
    );
  }

  @Get(['documents/bulk', 'rag/documents/bulk'])
  @ApiOperation({ summary: 'Get metadata for multiple documents' })
  async getDocumentsBulkGet(@Query('ids') ids: string) {
    const list = ids
      ? ids
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [];
    return this.ragAgentService.getDocumentsBulk(list);
  }

  @Post(['documents/bulk', 'rag/documents/bulk'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Post list of IDs for bulk document metadata' })
  async getDocumentsBulkPost(@Body() dto: BulkDocumentsDto) {
    const list = dto.ids || [];
    return this.ragAgentService.getDocumentsBulk(list);
  }

  @Get(['documents/:docId', 'documents/:docId/content', 'rag/documents/:docId'])
  @ApiOperation({ summary: 'Get document details and extracted content' })
  async getDocument(@Param('docId') docId: string) {
    return this.ragAgentService.getDocument(docId);
  }

  @Get(['documents', 'rag/documents'])
  @ApiOperation({ summary: 'Get all indexed reference documents' })
  async getDocuments() {
    return this.ragAgentService.getDocuments();
  }
}
