/**
 * filestore/filestore.controller.ts
 * Inbound HTTP Controller exposing Overleaf-compatible endpoints for binary assets.
 */

import {
  Controller,
  Get,
  Post,
  Head,
  Delete,
  Param,
  Headers,
  Req,
  Res,
  Query,
  BadRequestException,
  NotFoundException,
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { PageBinaryAssetResponseDto } from './dto/file-response.dto';
import { FileNotFoundException, InvalidByteRangeException } from './domain/filestore.errors';
import { FilestoreService } from './filestore.service';
import { resolvePageControllerCoordinates } from '@/modules/pages/core';

const STRICT_MIME_REGEX = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

const ACTIVE_DANGEROUS_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/xml',
  'application/xml',
]);

function sanitizeMimeType(raw?: string): string {
  const base = (raw || '').split(';')[0].trim().toLowerCase().slice(0, 128);
  if (!base || !STRICT_MIME_REGEX.test(base)) {
    return 'application/octet-stream';
  }
  return base;
}

function resolveSafeDownloadContentType(
  mimeType: string,
  filename: string,
): string {
  const safe = sanitizeMimeType(mimeType);
  const lowerName = (filename || '').toLowerCase();
  const isActiveExtension =
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.htm') ||
    lowerName.endsWith('.xhtml') ||
    lowerName.endsWith('.svg');

  if (ACTIVE_DANGEROUS_MIME_TYPES.has(safe) || isActiveExtension) {
    return 'application/octet-stream';
  }
  return safe;
}

@ApiTags('Pages - Binary Assets & Filestore')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/spaces/:spaceId/files',
  'api/v1/pages/spaces/:spaceId/filestore',
  'api/v1/pages/pages/:pageId/files',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class FilestoreController {
  constructor(private readonly filestoreService: FilestoreService) {}

  private resolveCoordinates(
    params: { spaceId?: string; pageId?: string },
    resolvedSpace?: string | { id?: string } | null,
    queryPageId?: string,
    req?: FastifyRequest,
  ): { spaceId: string; pageId?: string } {
    return resolvePageControllerCoordinates(
      params,
      resolvedSpace,
      queryPageId,
      req,
    );
  }

  private applySafeAssetHeaders(
    res: FastifyReply,
    file: { mimeType: string; name: string },
  ): void {
    res.header(
      'Content-Type',
      resolveSafeDownloadContentType(file.mimeType, file.name),
    );
    res.header('Accept-Ranges', 'bytes');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('Content-Security-Policy', 'sandbox');
    res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.name)}"`,
    );
  }

  @Post()
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('upload')
  @HttpCode(HttpStatus.CREATED)
  public async uploadFile(
    @Req() req: FastifyRequest,
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Query('name') queryName?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
  ): Promise<PageBinaryAssetResponseDto> {
    let filename = queryName || 'unnamed.bin';
    let mimeType = 'application/octet-stream';
    let dataStream: Readable;

    const multipartReq = req as FastifyRequest & {
      isMultipart?: () => boolean;
      file?: () => Promise<
        { filename?: string; mimetype?: string; file: Readable } | undefined
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
      filename = queryName || part.filename || filename;
      mimeType = part.mimetype || mimeType;
      dataStream = part.file;
    } else {
      dataStream = req.raw;
      const contentType = req.headers['content-type'];
      if (contentType) {
        mimeType = contentType.split(';')[0].trim();
      }
    }
    const safeMimeType = sanitizeMimeType(mimeType);

    const { spaceId, pageId } = this.resolveCoordinates(
      { spaceId: routeSpaceId, pageId: paramPageId },
      resolvedSpace,
      queryPageId,
      req,
    );

    const savedFile = await this.filestoreService.uploadFileFromStream(
      spaceId,
      filename,
      dataStream,
      safeMimeType,
      'manuscript-files',
      { pageId },
    );

    return PageBinaryAssetResponseDto.fromEntity(savedFile);
  }

  @Head(':fileId')
  public async getFileHead(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') paramPageId?: string,
    @Req() req?: FastifyRequest,
    @Query('pageId') queryPageId?: string,
  ): Promise<void> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        { spaceId: routeSpaceId, pageId: paramPageId },
        resolvedSpace,
        queryPageId,
        req,
      );
      const { file } = await this.filestoreService.getFileHead(
        spaceId,
        fileId,
        pageId,
      );

      res.header('Content-Length', file.sizeBytes.toString());
      this.applySafeAssetHeaders(res, file);
      res.status(200).send();
    } catch (err) {
      if (err instanceof FileNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Get()
  public async listFiles(
    @Param('spaceId') routeSpaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ): Promise<PageBinaryAssetResponseDto[]> {
    const { spaceId, pageId } = this.resolveCoordinates(
      { spaceId: routeSpaceId, pageId: paramPageId },
      resolvedSpace,
      queryPageId,
      req,
    );
    const files = await this.filestoreService.listFiles(spaceId, false, pageId);
    return files.map((f) => PageBinaryAssetResponseDto.fromEntity(f));
  }

  @Get('raw')
  public async streamFileByPath(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Query('path') queryPath: string | undefined,
    @Query('name') queryName: string | undefined,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: FastifyReply,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') paramPageId?: string,
    @Req() req?: FastifyRequest,
  ): Promise<void> {
    const rawPath = queryPath || queryName;
    if (!rawPath) {
      throw new BadRequestException(
        'Query parameter "path" or "name" is required.',
      );
    }
    const { spaceId, pageId } = this.resolveCoordinates(
      { spaceId: routeSpaceId, pageId: paramPageId },
      resolvedSpace,
      queryPageId,
      req,
    );
    const file = await this.filestoreService.findFileByPathFlexible(
      spaceId,
      rawPath,
      pageId,
    );
    if (!file) {
      throw new NotFoundException(
        `File asset "${rawPath}" not found in space ${spaceId}.`,
      );
    }

    return this.streamFile(
      spaceId,
      file.id,
      rangeHeader,
      res,
      resolvedSpace,
      paramPageId || pageId,
      req,
      queryPageId,
    );
  }

  @Get(':fileId')
  public async streamFile(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Param('fileId') fileId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: FastifyReply,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') paramPageId?: string,
    @Req() req?: FastifyRequest,
    @Query('pageId') queryPageId?: string,
  ): Promise<void> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        { spaceId: routeSpaceId, pageId: paramPageId },
        resolvedSpace,
        queryPageId,
        req,
      );
      const result = await this.filestoreService.streamFile(
        spaceId,
        fileId,
        rangeHeader,
        pageId,
      );

      const { file, stream, byteRange, isPartialContent, contentLength } =
        result;

      this.applySafeAssetHeaders(res, file);
      res.header('Cache-Control', 'private, max-age=3600, immutable');

      if (isPartialContent && byteRange) {
        res.status(206);
        res.header('Content-Range', byteRange.toContentRangeHeader());
        res.header('Content-Length', contentLength.toString());
      } else {
        res.status(200);
        res.header('Content-Length', contentLength.toString());
      }

      return res.send(stream);
    } catch (err) {
      if (err instanceof FileNotFoundException) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof InvalidByteRangeException) {
        res.status(416);
        res.header('Content-Range', `bytes */${err.totalSizeBytes}`);
        res.send(err.message);
        return;
      }
      throw err;
    }
  }

  @Delete(':fileId')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteFile(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Param('fileId') fileId: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') paramPageId?: string,
    @Req() req?: FastifyRequest,
    @Query('pageId') queryPageId?: string,
  ): Promise<void> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        { spaceId: routeSpaceId, pageId: paramPageId },
        resolvedSpace,
        queryPageId,
        req,
      );
      await this.filestoreService.deleteFile(spaceId, fileId, false, pageId);
    } catch (err) {
      if (err instanceof FileNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Get(':fileId/signed-url')
  public async getSignedUrl(
    @Param('spaceId') routeSpaceId: string | undefined,
    @Param('fileId') fileId: string,
    @Query('expiresIn') expiresIn?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Param('pageId') paramPageId?: string,
    @Req() req?: FastifyRequest,
    @Query('pageId') queryPageId?: string,
  ): Promise<{ signedUrl: string | null }> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        { spaceId: routeSpaceId, pageId: paramPageId },
        resolvedSpace,
        queryPageId,
        req,
      );
      const parsedTtl = expiresIn ? Number.parseInt(expiresIn, 10) : 3600;
      const ttl = Number.isFinite(parsedTtl)
        ? Math.min(Math.max(parsedTtl, 60), 604800)
        : 3600;
      const signedUrl = await this.filestoreService.getSignedUrl(
        spaceId,
        fileId,
        ttl,
        pageId,
      );
      return { signedUrl };
    } catch (err) {
      if (err instanceof FileNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }
}
