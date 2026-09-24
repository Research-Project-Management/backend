/**
 * modules/manuscripts/docstore/docstore.controller.ts
 * REST API Controller matching Overleaf docstore routes 1:1.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  HttpStatus,
  HttpCode,
  BadRequestException,
  NotFoundException,
  ConflictException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DocstoreService } from './docstore.service';
import { CreateDocDto, UpdateDocDto, PatchDocDto } from './dto/doc.dto';
import {
  DocNotFoundError,
  DocModifiedError,
  DocTooLargeError,
  NullByteDetectedError,
} from './core/domain/doc-errors';

@ApiTags('Manuscripts - Docstore')
@Controller([
  'manuscripts/projects/:projectId/docs',
  'api/manuscripts/projects/:projectId/docs',
  'api/projects/:projectId/pages',
  'projects/:projectId/pages',
  'docstore/project/:projectId',
])
export class DocstoreController {
  constructor(private readonly docstoreService: DocstoreService) {}

  private handleError(error: any): never {
    if (error instanceof DocNotFoundError) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof DocModifiedError) {
      throw new ConflictException({
        message: error.message,
        details: error.details,
      });
    }
    if (error instanceof DocTooLargeError) {
      throw new PayloadTooLargeException(error.message);
    }
    if (error instanceof NullByteDetectedError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get('doc')
  @ApiOperation({ summary: 'Get all non-deleted documents in project (Bulk query for CLSI)' })
  async getAllDocs(@Param('projectId') projectId: string) {
    try {
      return await this.docstoreService.getAllDocs(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('doc-deleted')
  @ApiOperation({ summary: 'Get all soft-deleted documents in project' })
  async getAllDeletedDocs(@Param('projectId') projectId: string) {
    try {
      return await this.docstoreService.getAllDeletedDocs(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('ranges')
  @ApiOperation({ summary: 'Get all document ranges (track changes / comments) in project' })
  async getAllRanges(@Param('projectId') projectId: string) {
    try {
      return await this.docstoreService.getAllRanges(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('doc/:docId')
  @ApiOperation({ summary: 'Get single document with lines and version' })
  async getDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Query('include_deleted') includeDeleted?: string
  ) {
    try {
      return await this.docstoreService.getDoc(projectId, docId, {
        includeDeleted: includeDeleted === 'true',
      });
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('doc/:docId/deleted')
  @ApiOperation({ summary: 'Check if document is marked as deleted' })
  async isDocDeleted(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string
  ) {
    try {
      const deleted = await this.docstoreService.isDocDeleted(projectId, docId);
      return { deleted };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('doc/:docId/raw')
  @ApiOperation({ summary: 'Get raw document text as text/plain' })
  async getRawDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Res() reply: FastifyReply
  ) {
    try {
      const rawText = await this.docstoreService.getRawDoc(projectId, docId);
      reply.type('text/plain').send(rawText);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('doc/:docId/peek')
  @ApiOperation({ summary: 'Peek document without unarchiving from S3' })
  async peekDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Res() reply: FastifyReply
  ) {
    try {
      const { doc, status } = await this.docstoreService.peekDoc(projectId, docId);
      reply.header('x-doc-status', status).send(this.docstoreService.mapToDto(doc));
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('doc')
  @ApiOperation({ summary: 'Create new document' })
  async createDoc(
    @Param('projectId') projectId: string,
    @Body() dto: CreateDocDto
  ) {
    try {
      return await this.docstoreService.createDoc(projectId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('doc/:docId')
  @ApiOperation({ summary: 'Update document lines with OCC revision check' })
  async updateDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Body() dto: UpdateDocDto
  ) {
    try {
      const result = await this.docstoreService.updateDoc(projectId, docId, dto);
      return {
        modified: result.modified,
        rev: result.rev,
      };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Patch('doc/:docId')
  @ApiOperation({ summary: 'Patch document metadata or soft-delete' })
  async patchDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Body() dto: PatchDocDto
  ) {
    try {
      return await this.docstoreService.patchDoc(projectId, docId, dto);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('doc/:docId')
  @ApiOperation({ summary: 'Delete document (Deprecated in Overleaf - returns error instructing PATCH)' })
  deleteDoc() {
    throw new BadRequestException('DELETE-ing a doc is DEPRECATED. PATCH the doc with deleted: true instead.');
  }

  @Post('archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive all documents in project to Cold Tier (S3)' })
  async archiveAllDocs(@Param('projectId') projectId: string) {
    try {
      await this.docstoreService.archiveAllDocs(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('doc/:docId/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive single document to Cold Tier (S3)' })
  async archiveDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string
  ) {
    try {
      await this.docstoreService.archiveDoc(projectId, docId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('unarchive')
  @ApiOperation({ summary: 'Unarchive all documents in project from Cold Tier (S3)' })
  async unArchiveAllDocs(@Param('projectId') projectId: string) {
    try {
      const count = await this.docstoreService.unArchiveAllDocs(projectId);
      return { unarchived: count };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('destroy')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently destroy all documents in project' })
  async destroyAllDocs(@Param('projectId') projectId: string) {
    try {
      await this.docstoreService.destroyAllDocs(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }
}
