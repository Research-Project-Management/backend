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
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
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
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/manuscripts/projects', 'manuscripts/projects', 'projects'])
@UseGuards(JwtAuthGuard)
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

  @Get([':projectId/export/zip', ':projectId/export'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Export complete manuscript project as a PKZIP archive',
  })
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
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Import an existing LaTeX project from an uploaded ZIP archive',
  })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async importProjectZip(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @Query('preferredRootDoc') preferredRootDoc?: string,
  ): Promise<ImportSummaryResponseDto> {
    try {
      let zipBuffer: Buffer;

      const multipartReq = req as FastifyRequest & {
        isMultipart?: () => boolean;
        file?: () => Promise<{ toBuffer: () => Promise<Buffer> } | undefined>;
      };
      const isMultipart =
        typeof multipartReq.isMultipart === 'function'
          ? multipartReq.isMultipart()
          : Boolean(multipartReq.isMultipart);

      if (isMultipart && typeof multipartReq.file === 'function') {
        const part = await multipartReq.file();
        if (!part) {
          throw new BadRequestException('No file found in multipart upload.');
        }
        zipBuffer = await part.toBuffer();
      } else if (Buffer.isBuffer(req.body)) {
        zipBuffer = req.body;
      } else if (
        typeof req.body === 'object' &&
        req.body !== null &&
        'buffer' in req.body &&
        Buffer.isBuffer(req.body.buffer)
      ) {
        zipBuffer = (req.body as { buffer: Buffer }).buffer;
      } else {
        throw new BadRequestException(
          'Expected ZIP archive binary payload or multipart form data.',
        );
      }

      return await this.service.importProjectZip(
        projectId,
        zipBuffer,
        undefined,
        preferredRootDoc,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('templates')
  @ApiOperation({
    summary: 'List all academic starter templates in the catalog',
  })
  @ApiResponse({ status: 200, type: [TemplateResponseDto] })
  public async listTemplates(): Promise<TemplateResponseDto[]> {
    try {
      return await this.service.listTemplates();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(':projectId/templates/:templateId/scaffold')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Initialize project structure and files from an academic template',
  })
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
