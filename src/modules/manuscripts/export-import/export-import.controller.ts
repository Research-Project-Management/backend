/**
 * export-import/export-import.controller.ts
 * Inbound HTTP Controller for Manuscripts ZIP Export/Import and Template Scaffolding.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  Res,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ExportImportService } from './export-import.service';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
  TemplateResponseDto,
  ScaffoldTemplateDto,
} from './dto/export-import.dto';
import { InvalidZipArchiveException } from './core/domain/exceptions/invalid-zip-archive.exception';
import { ZipSlipSecurityException } from './core/domain/exceptions/zip-slip-security.exception';
import { ArchiveSizeExceededException } from './core/domain/exceptions/archive-size-exceeded.exception';
import { TemplateNotFoundException } from './core/domain/exceptions/template-not-found.exception';

@ApiTags('Manuscripts - Project Archive & Templates')
@Controller([
  'api/v1/manuscripts/projects',
  'manuscripts/projects',
  'projects',
])
export class ExportImportController {
  constructor(private readonly service: ExportImportService) {}

  private handleError(error: any): never {
    if (error instanceof InvalidZipArchiveException) {
      throw new BadRequestException(error.message);
    }
    if (error instanceof ZipSlipSecurityException) {
      throw new ForbiddenException(error.message);
    }
    if (error instanceof ArchiveSizeExceededException) {
      throw new PayloadTooLargeException(error.message);
    }
    if (error instanceof TemplateNotFoundException) {
      throw new NotFoundException(error.message);
    }
    throw error;
  }

  @Get(':projectId/export/zip')
  @ApiOperation({ summary: 'Export complete manuscript project as a PKZIP archive' })
  public async exportProjectZip(
    @Param('projectId') projectId: string,
    @Query() query: ExportZipQueryDto,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.service.exportProjectZip(projectId, query);
      const filename = `${result.manifest.projectName}.zip`;

      res.header('Content-Type', 'application/zip');
      res.header('Content-Disposition', `attachment; filename="${filename}"`);
      res.header('Content-Length', result.zipBuffer.length.toString());
      return res.send(result.zipBuffer);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(':projectId/import/zip')
  @ApiOperation({ summary: 'Import an existing LaTeX project from an uploaded ZIP archive' })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async importProjectZip(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @Query('preferredRootDoc') preferredRootDoc?: string,
  ): Promise<ImportSummaryResponseDto> {
    try {
      let zipBuffer: Buffer;

      const isMultipart =
        typeof (req as any).isMultipart === 'function'
          ? (req as any).isMultipart()
          : Boolean((req as any).isMultipart);

      if (isMultipart && typeof (req as any).file === 'function') {
        const part = await (req as any).file();
        if (!part) {
          throw new BadRequestException('No file found in multipart upload.');
        }
        zipBuffer = await part.toBuffer();
      } else if (Buffer.isBuffer(req.body)) {
        zipBuffer = req.body;
      } else if (req.body && (req.body as any).buffer && Buffer.isBuffer((req.body as any).buffer)) {
        zipBuffer = (req.body as any).buffer;
      } else {
        throw new BadRequestException('Expected ZIP archive binary payload or multipart form data.');
      }

      return await this.service.importProjectZip(projectId, zipBuffer, undefined, preferredRootDoc);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('templates')
  @ApiOperation({ summary: 'List all academic starter templates in the catalog' })
  @ApiResponse({ status: 200, type: [TemplateResponseDto] })
  public async listTemplates(): Promise<TemplateResponseDto[]> {
    try {
      return await this.service.listTemplates();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(':projectId/templates/:templateId/scaffold')
  @ApiOperation({ summary: 'Initialize project structure and files from an academic template' })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async scaffoldFromTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @Body() dto?: ScaffoldTemplateDto,
  ): Promise<ImportSummaryResponseDto> {
    try {
      const targetTemplateId = templateId || dto?.templateId || '';
      return await this.service.scaffoldTemplate(projectId, targetTemplateId);
    } catch (err) {
      this.handleError(err);
    }
  }
}
