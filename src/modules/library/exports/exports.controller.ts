import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { ExportsService } from './exports.service';
import { ExportLibraryDto, ExportFormatType } from './dto/export.dto';

import { PdfExportService } from './pdf-export.service';

@Controller('api/v1/workspaces/:workspaceId/library/exports')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ExportsController {
  constructor(
    private readonly exportsService: ExportsService,
    private readonly pdfExportService: PdfExportService,
  ) {}

  @Get('items/:itemId/annotated-pdf')
  async exportAnnotatedPdf(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const res = await this.pdfExportService.exportAnnotatedItemPdf(
      workspaceId,
      itemId,
    );
    return {
      filename: res.filename,
      mimeType: 'application/pdf',
      base64: Buffer.from(res.buffer).toString('base64'),
    };
  }

  @Post()
  async exportLibrary(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ExportLibraryDto,
  ) {
    return this.exportsService.exportLibrary(workspaceId, dto);
  }

  @Get()
  async exportLibraryGet(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionIdParam: string | undefined,
    @Query('format') format?: ExportFormatType,
    @Query('collectionId') collectionIdQuery?: string,
    @Query('tagId') tagId?: string,
  ) {
    const targetCollectionId = collectionIdParam || collectionIdQuery;
    if (collectionIdParam) {
      return this.exportsService.exportBundle(workspaceId, collectionIdParam);
    }

    const effectiveFormat = format || 'bibtex';
    const result = await this.exportsService.exportLibrary(workspaceId, {
      format: effectiveFormat,
      collectionId: targetCollectionId,
      tagId,
    });

    return {
      ...result,
      bibtex: result.content,
      total: result.itemCount,
      filename: result.filename,
    };
  }

  @Get(':collectionId/export-bundle')
  async getCollectionBundle(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.exportsService.exportBundle(workspaceId, collectionId);
  }
}
