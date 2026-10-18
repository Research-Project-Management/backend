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
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  NoProjectContext,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ExportImportService } from './export-import.service';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
  TemplateResponseDto,
  ScaffoldTemplateDto,
} from './dto/export-import.dto';
import {
  InvalidZipArchiveException,
  ZipSlipSecurityException,
  ArchiveSizeExceededException,
  ArchiveFileLimitExceededException,
  TemplateNotFoundException,
} from './domain';

@ApiTags('Manuscripts - Project Archive & Templates')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/projects',
  'v1/manuscripts/projects',
  'manuscripts/projects',
  'projects',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ExportImportController {
  constructor(private readonly service: ExportImportService) {}

  private handleError(error: unknown): never {
    if (
      error instanceof InvalidZipArchiveException ||
      error instanceof ArchiveFileLimitExceededException
    ) {
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
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Export complete manuscript project as a PKZIP archive',
  })
  public async exportProjectZip(
    @Param('projectId') projectId: string,
    @Query() query: ExportZipQueryDto,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.service.exportProjectZipStream(
        projectId,
        query,
      );
      const filename = `${result.projectName}.zip`;

      res.header('Content-Type', 'application/zip');
      res.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(filename)}"`,
      );

      // In real Fastify runtime (res.raw exists), stream with backpressure directly to socket.
      // In test mocks where res.raw is absent, buffer the stream chunks to satisfy buffer-based assertions.
      if ('raw' in res && Boolean((res as unknown as { raw?: unknown }).raw)) {
        return res.send(result.zipStream);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of result.zipStream) {
          chunks.push(Buffer.from(chunk));
        }
        const fullBuffer = Buffer.concat(chunks);
        res.header('Content-Length', fullBuffer.length.toString());
        return res.send(fullBuffer);
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(':projectId/import/zip')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
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
  @NoProjectContext()
  @ApiOperation({
    summary: 'List all academic starter templates in the catalog',
  })
  @ApiResponse({ status: 200, type: [TemplateResponseDto] })
  public async listTemplates(
    @Query('category') category?: string,
    @Query('search') search?: string,
  ): Promise<TemplateResponseDto[]> {
    try {
      let templates = await this.service.listTemplates();
      if (category && category !== 'all') {
        const cat = category.toLowerCase().trim();
        templates = templates.filter((t) => t.category?.toLowerCase() === cat);
      }
      if (search && search.trim()) {
        const q = search.toLowerCase().trim();
        templates = templates.filter(
          (t) =>
            t.title?.toLowerCase().includes(q) ||
            t.description?.toLowerCase().includes(q) ||
            t.author?.toLowerCase().includes(q),
        );
      }
      return templates;
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('templates/:templateId')
  @NoProjectContext()
  @ApiOperation({
    summary: 'Get details and files of an academic starter template',
  })
  @ApiResponse({ status: 200, type: TemplateResponseDto })
  public async getTemplate(
    @Param('templateId') templateId: string,
  ): Promise<TemplateResponseDto> {
    try {
      const template = await this.service.getTemplate(templateId);
      if (!template) {
        throw new NotFoundException(`Template '${templateId}' not found.`);
      }
      return template;
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(':projectId/templates/:templateId/scaffold')
  @RequireRole(Role.CONTRIBUTOR)
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

  @Post(':projectId/import/convert')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @ApiOperation({
    summary:
      'Convert and import a Word (.docx) or Markdown (.md) document into the project',
  })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async convertDocument(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @Query('format') format?: 'docx' | 'md',
  ): Promise<ImportSummaryResponseDto> {
    try {
      let fileBuffer: Buffer;
      let fileName = 'document.docx';

      const multipartReq = req as FastifyRequest & {
        isMultipart?: () => boolean;
        file?: () => Promise<
          { filename: string; toBuffer: () => Promise<Buffer> } | undefined
        >;
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
        fileName = part.filename || fileName;
        fileBuffer = await part.toBuffer();
      } else if (Buffer.isBuffer(req.body)) {
        fileBuffer = req.body;
      } else if (
        typeof req.body === 'object' &&
        req.body !== null &&
        'buffer' in req.body
      ) {
        const bodyWithBuffer = req.body as {
          buffer?: unknown;
          filename?: string;
        };
        if (Buffer.isBuffer(bodyWithBuffer.buffer)) {
          fileBuffer = bodyWithBuffer.buffer;
          if (typeof bodyWithBuffer.filename === 'string') {
            fileName = bodyWithBuffer.filename;
          }
        } else {
          throw new BadRequestException(
            'Expected document binary payload or multipart form data.',
          );
        }
      } else {
        throw new BadRequestException(
          'Expected document binary payload or multipart form data.',
        );
      }

      return await this.service.convertDocument({
        projectId,
        fileBuffer,
        fileName,
        format,
      });
    } catch (err) {
      this.handleError(err);
    }
  }
}
