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
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { resolvePageControllerCoordinates } from '@/modules/pages/core/utils/page-scope';
import { UserRateLimit, UserRateLimitGuard } from '@/core';

import { ExportService } from './services/export.service';
import { ImportService } from './services/import.service';
import { ConvertService } from './services/convert.service';

import { ExportDocumentDto, ExportZipQueryDto } from './dto/export.dto';
import { ImportSummaryResponseDto, ImportUrlDto } from './dto/import.dto';

async function readUploadPayload(
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

@ApiTags('Pages - Project Archive & Templates')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class ExportImportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly importService: ImportService,
    private readonly convertService: ConvertService,
  ) {}

  @Get('spaces/:spaceId/export/zip')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({
    summary: 'Export complete manuscript project as a PKZIP archive',
  })
  public async exportProjectZip(
    @Param('spaceId') routeSpaceId: string,
    @Query() query: ExportZipQueryDto,
    @Res() res: FastifyReply,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ): Promise<void> {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      authorizedSpace,
      queryPageId ?? query?.pageId,
      req,
    );
    const effectiveQuery = pageId ? { ...query, pageId } : query;
    const result = await this.exportService.exportProjectZipStream(
      spaceId,
      effectiveQuery,
    );
    const filename = `${result.projectName}.zip`;

    res.header('Content-Type', 'application/zip');
    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );

    if ('raw' in res && Boolean((res as unknown as { raw?: unknown }).raw)) {
      return res.send(result.zipStream);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of result.zipStream) {
      chunks.push(Buffer.from(chunk));
    }
    const fullBuffer = Buffer.concat(chunks);
    res.header('Content-Length', fullBuffer.length.toString());
    return res.send(fullBuffer);
  }

  @Post('spaces/:spaceId/import/zip')
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
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
  ): Promise<ImportSummaryResponseDto> {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      authorizedSpace,
      queryPageId,
      req,
    );
    const { buffer: zipBuffer } = await readUploadPayload(
      req,
      'archive.zip',
      'Expected ZIP archive binary payload or multipart form data.',
    );

    return this.importService.importProjectZip(
      spaceId,
      zipBuffer,
      undefined,
      preferredRootDoc,
      pageId,
    );
  }

  @Post('spaces/:spaceId/import/convert')
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
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
  ): Promise<ImportSummaryResponseDto> {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      authorizedSpace,
      queryPageId,
      req,
    );
    const { buffer: fileBuffer, filename: fileName } = await readUploadPayload(
      req,
      'document.docx',
      'Expected document binary payload or multipart form data.',
    );

    return this.convertService.convertDocument({
      projectId: spaceId,
      fileBuffer,
      fileName,
      format,
      pageId,
    });
  }

  @Post('docs/:pageId/export')
  @RequireRole(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  public async exportDocument(
    @Param('pageId') pageId: string,
    @Body() body?: ExportDocumentDto,
    @Query('format') queryFormat?: string,
    @Query('includeChildren') queryIncludeChildren?: string,
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    return this.convertService.exportSingleDocument({
      pageId,
      format: body?.format || queryFormat,
      includeChildren: body?.includeChildren ?? queryIncludeChildren,
      project,
    });
  }

  @Post('spaces/:spaceId/import/url')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.OK)
  public async importFromUrl(
    @Param('spaceId') spaceId: string,
    @Body() dto: ImportUrlDto,
    @Req() req?: { user?: { sub?: string; id?: string; userId?: string } },
    @ResolvedSpace() project?: string | { id: string } | null,
  ) {
    const effectiveSpaceId =
      (typeof project === 'string' ? project : project?.id) || spaceId;
    const userId = req?.user?.sub || req?.user?.id || req?.user?.userId;
    return this.importService.importFromUrl(
      effectiveSpaceId,
      dto.url,
      dto.filename,
      dto.pageId,
      userId,
    );
  }
}
