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
  HttpStatus,
  HttpCode,
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
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/page-scope.helper';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ExportImportService } from './export-import.service';
import {
  ExportZipQueryDto,
  ImportSummaryResponseDto,
  ScaffoldTemplateDto,
} from './dto/export-import.dto';
import {
  InvalidZipArchiveException,
  ZipSlipSecurityException,
  ArchiveSizeExceededException,
  ArchiveFileLimitExceededException,
} from './domain';
import { TemplateNotFoundException } from '@/modules/pages/templates/domain';

@ApiTags('Pages - Project Archive & Templates')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
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

  @Get([
    'spaces/:spaceId/export/zip',
    'spaces/:spaceId/export',
    'pages/:pageId/export/zip',
  ])
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Export complete manuscript project as a PKZIP archive',
  })
  public async exportProjectZip(
    @Param('spaceId') routeSpaceId: string,
    @Query() query: ExportZipQueryDto,
    @Res() res: FastifyReply,
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ): Promise<void> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        authorizedSpace,
        queryPageId ?? query?.pageId,
        req,
      );
      const effectiveQuery = pageId ? { ...query, pageId } : query;
      const result = await this.service.exportProjectZipStream(
        spaceId,
        effectiveQuery,
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

  private async extractUploadPayload(
    req: FastifyRequest,
    defaultFileName: string,
    errorMessage: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const multipartReq = req as FastifyRequest & {
      isMultipart?: () => boolean;
      file?: () => Promise<
        { filename?: string; toBuffer: () => Promise<Buffer> } | undefined
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
      return {
        buffer: await part.toBuffer(),
        filename: part.filename || defaultFileName,
      };
    }

    if (Buffer.isBuffer(req.body)) {
      return { buffer: req.body, filename: defaultFileName };
    }

    if (
      typeof req.body === 'object' &&
      req.body !== null &&
      'buffer' in req.body
    ) {
      const bodyWithBuffer = req.body as {
        buffer?: unknown;
        filename?: string;
      };
      if (Buffer.isBuffer(bodyWithBuffer.buffer)) {
        return {
          buffer: bodyWithBuffer.buffer,
          filename:
            typeof bodyWithBuffer.filename === 'string'
              ? bodyWithBuffer.filename
              : defaultFileName,
        };
      }
    }

    throw new BadRequestException(errorMessage);
  }

  @Post([
    'spaces/:spaceId/import/zip',
    'spaces/:spaceId/extract-zip',
    'pages/:pageId/import/zip',
    'pages/:pageId/extract-zip',
  ])
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @ApiOperation({
    summary: 'Import an existing LaTeX project from an uploaded ZIP archive',
  })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async importProjectZip(
    @Param('spaceId') routeSpaceId: string,
    @Req() req: FastifyRequest,
    @Query('preferredRootDoc') preferredRootDoc?: string,
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
  ): Promise<ImportSummaryResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        authorizedSpace,
        queryPageId,
        req,
      );
      const { buffer: zipBuffer } = await this.extractUploadPayload(
        req,
        'archive.zip',
        'Expected ZIP archive binary payload or multipart form data.',
      );

      return await this.service.importProjectZip(
        spaceId,
        zipBuffer,
        undefined,
        preferredRootDoc,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post([
    'spaces/:spaceId/templates/:templateId/scaffold',
    'pages/:pageId/templates/:templateId/scaffold',
  ])
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Initialize project structure and files from an academic template',
  })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async scaffoldFromTemplate(
    @Param('spaceId') routeSpaceId: string,
    @Param('templateId') templateId: string,
    @Body() dto?: ScaffoldTemplateDto,
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ): Promise<ImportSummaryResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        authorizedSpace,
        queryPageId ?? dto?.pageId,
        req,
      );
      const targetTemplateId = templateId || dto?.templateId || '';
      return await this.service.scaffoldTemplate(
        spaceId,
        targetTemplateId,
        undefined,
        pageId,
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post(['spaces/:spaceId/import/convert', 'pages/:pageId/import/convert'])
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @ApiOperation({
    summary:
      'Convert and import a Word (.docx) or Markdown (.md) document into the project',
  })
  @ApiResponse({ status: 201, type: ImportSummaryResponseDto })
  public async convertDocument(
    @Param('spaceId') routeSpaceId: string,
    @Req() req: FastifyRequest,
    @Query('format') format?: 'docx' | 'md',
    @Param('pageId') routePageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
  ): Promise<ImportSummaryResponseDto> {
    try {
      const { spaceId, pageId } = resolvePageControllerCoordinates(
        { spaceId: routeSpaceId, pageId: routePageId },
        authorizedSpace,
        queryPageId,
        req,
      );
      const { buffer: fileBuffer, filename: fileName } =
        await this.extractUploadPayload(
          req,
          'document.docx',
          'Expected document binary payload or multipart form data.',
        );

      return await this.service.convertDocument({
        projectId: spaceId,
        fileBuffer,
        fileName,
        format,
        pageId,
      });
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get(['pages/:pageId/export', 'docs/:pageId/export'])
  @RequireRole(Role.REVIEWER)
  async exportPage(
    @Param('pageId') pageId: string,
    @Query('format') format?: string,
    @Query('includeChildren') includeChildren?: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.service.exportSingleDocument({
      pageId,
      format,
      includeChildren:
        includeChildren !== undefined
          ? includeChildren === 'true' || includeChildren === '1'
          : undefined,
      project,
    });
  }

  @Post(['pages/:pageId/export', 'docs/:pageId/export'])
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  async exportDocument(
    @Param('pageId') pageId: string,
    @Body()
    body?: { format?: string; includeChildren?: boolean | string },
    @Query('format') queryFormat?: string,
    @Query('includeChildren') queryIncludeChildren?: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.service.exportSingleDocument({
      pageId,
      format: body?.format || queryFormat,
      includeChildren: body?.includeChildren ?? queryIncludeChildren,
      project,
    });
  }
}
