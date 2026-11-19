import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import '@fastify/multipart';
import {
  CurrentUser,
  JwtAuthGuard,
  VerifiedEmailGuard,
} from '@/modules/identity/auth';
import { normalizeScopeAlias } from '../access/domain/scope.mapper';
import { GetKnowledgeBulkDto } from './dto/knowledge.dto';
import { KnowledgeService } from './services/knowledge.service';

@ApiTags('AI - Knowledge')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai/documents')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post('upload')
  @UseGuards(VerifiedEmailGuard)
  @ApiOperation({ summary: 'Upload document to AI knowledge vector store' })
  async uploadDocument(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const parts = req.parts();
    let buffer: Buffer | null = null;
    let filename = 'document';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, string> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename;
        mimeType = part.mimetype;
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] =
          typeof part.value === 'string' || typeof part.value === 'number'
            ? String(part.value)
            : '';
      }
    }

    if (!buffer) {
      throw new BadRequestException('File is required');
    }

    const spaceId = normalizeScopeAlias(fields.spaceId || fields.space_id);
    const chatId = fields.chatId || fields.chat_id;

    return this.knowledgeService.uploadDocument(
      userId,
      buffer,
      mimeType,
      filename,
      {
        spaceId,
        chatId: chatId || undefined,
        title: fields.title || undefined,
        tags: fields.tags || undefined,
      },
    );
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk retrieve indexed knowledge documents by IDs' })
  async getDocumentsBulk(
    @CurrentUser('id') userId: string,
    @Body() body: GetKnowledgeBulkDto,
  ) {
    return this.knowledgeService.getDocumentsBulk(
      userId,
      body.ids || [],
      body.spaceId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List indexed knowledge documents in space' })
  async getDocuments(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.knowledgeService.getDocuments(userId, spaceId);
  }

  @Get([':docId', ':docId/content'])
  @ApiOperation({ summary: 'Retrieve knowledge document content/chunks' })
  async getDocument(
    @CurrentUser('id') userId: string,
    @Param('docId') docId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.knowledgeService.getDocumentContent(userId, docId, spaceId);
  }

  @Delete(':docId')
  @ApiOperation({ summary: 'Delete knowledge document from vector store' })
  async deleteDocument(
    @CurrentUser('id') userId: string,
    @Param('docId') docId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.knowledgeService.deleteDocument(userId, docId, spaceId);
  }
}
