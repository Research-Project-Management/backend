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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  ResolvedProject,
  Role,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ManuscriptFileResponseDto } from './dto/file-response.dto';
import {
  FileNotFoundException,
  InvalidByteRangeException,
} from './filestore.types';
import { FilestoreService } from './filestore.service';

@ApiTags('Manuscripts - Filestore & Assets')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages/projects/:projectId/files',
  'api/v1/pages/projects/:projectId/filestore',
  'api/v1/pages/pages/:projectId/files',
  'api/v1/manuscripts/projects/:projectId/files',
  'api/v1/manuscripts/projects/:projectId/filestore',
  'api/v1/manuscripts/pages/:projectId/files',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class FilestoreController {
  constructor(private readonly filestoreService: FilestoreService) {}

  private resolveCoordinates(
    paramProjectId: string,
    resolvedProject?: string | { id?: string } | null,
    queryPageId?: string,
  ): { spaceId: string; pageId?: string } {
    const authorized =
      typeof resolvedProject === 'string'
        ? resolvedProject
        : resolvedProject?.id;
    const spaceId = authorized || paramProjectId;
    const cleanQueryPageId = queryPageId?.trim() || undefined;
    const pageId =
      cleanQueryPageId && cleanQueryPageId !== spaceId
        ? cleanQueryPageId
        : authorized && paramProjectId && paramProjectId !== authorized
          ? paramProjectId
          : undefined;
    return { spaceId, pageId };
  }

  @Post()
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('upload')
  @HttpCode(HttpStatus.CREATED)
  public async uploadFile(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @Query('name') queryName?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<ManuscriptFileResponseDto> {
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

    const { spaceId, pageId } = this.resolveCoordinates(
      projectId,
      resolvedProject,
      queryPageId,
    );

    const savedFile = await this.filestoreService.uploadFileFromStream(
      spaceId,
      filename,
      dataStream,
      mimeType,
      'manuscript-files',
      { pageId },
    );

    return ManuscriptFileResponseDto.fromEntity(savedFile);
  }

  @Head(':fileId')
  public async getFileHead(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<void> {
    try {
      const { spaceId } = this.resolveCoordinates(projectId, resolvedProject);
      const { file } = await this.filestoreService.getFileHead(
        spaceId,
        fileId,
      );

      res.header('Content-Length', file.sizeBytes.toString());
      res.header('Content-Type', file.mimeType);
      res.header('Accept-Ranges', 'bytes');
      res.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(file.name)}"`,
      );
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
    @Param('projectId') projectId: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<ManuscriptFileResponseDto[]> {
    const { spaceId, pageId } = this.resolveCoordinates(
      projectId,
      resolvedProject,
      queryPageId,
    );
    const files = await this.filestoreService.listFiles(spaceId, false, pageId);
    return files.map((f) => ManuscriptFileResponseDto.fromEntity(f));
  }

  @Get('raw')
  public async streamFileByPath(
    @Param('projectId') projectId: string,
    @Query('path') queryPath: string | undefined,
    @Query('name') queryName: string | undefined,
    @Headers('range') rangeHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: FastifyReply,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<void> {
    const rawPath = queryPath || queryName;
    if (!rawPath) {
      throw new BadRequestException(
        'Query parameter "path" or "name" is required.',
      );
    }
    const { spaceId, pageId } = this.resolveCoordinates(
      projectId,
      resolvedProject,
      queryPageId,
    );
    const file = await this.filestoreService.findFileByPathFlexible(
      spaceId,
      rawPath,
      pageId,
    );
    if (!file) {
      throw new NotFoundException(
        `File asset "${rawPath}" not found in project ${spaceId}.`,
      );
    }

    return this.streamFile(
      spaceId,
      file.id,
      rangeHeader,
      userAgent,
      res,
      resolvedProject,
    );
  }

  @Get(':fileId')
  public async streamFile(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: FastifyReply,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<void> {
    try {
      const { spaceId } = this.resolveCoordinates(projectId, resolvedProject);
      const result = await this.filestoreService.streamFile(
        spaceId,
        fileId,
        rangeHeader,
      );

      const { file, stream, byteRange, isPartialContent, contentLength } =
        result;

      const isMobileSafari =
        userAgent &&
        (userAgent.includes('iPhone') || userAgent.includes('iPad'));
      const isHtml =
        file.name.endsWith('.html') ||
        file.name.endsWith('.htm') ||
        file.name.endsWith('.xhtml');

      if (isMobileSafari && isHtml) {
        res.header('Content-Type', 'text/plain; charset=utf-8');
      } else {
        res.header('Content-Type', file.mimeType);
      }

      res.header('Cache-Control', 'private, max-age=3600, immutable');
      res.header('Accept-Ranges', 'bytes');
      res.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(file.name)}"`,
      );

      if (isPartialContent && byteRange) {
        res.status(206);
        res.header('Content-Range', byteRange.toContentRangeHeader());
        res.header('Content-Length', contentLength.toString());
      } else {
        res.status(200);
        res.header('Content-Length', contentLength.toString());
      }

      await pipeline(stream, res.raw);
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
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<void> {
    try {
      const { spaceId } = this.resolveCoordinates(projectId, resolvedProject);
      await this.filestoreService.deleteFile(spaceId, fileId, true);
    } catch (err) {
      if (err instanceof FileNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Get(':fileId/signed-url')
  public async getSignedUrl(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Query('expiresIn') expiresIn?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ): Promise<{ signedUrl: string | null }> {
    try {
      const { spaceId } = this.resolveCoordinates(projectId, resolvedProject);
      const ttl = expiresIn ? parseInt(expiresIn, 10) : 3600;
      const signedUrl = await this.filestoreService.getSignedUrl(
        spaceId,
        fileId,
        ttl,
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
