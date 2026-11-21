import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BypassEnvelope, UserRateLimit, UserRateLimitGuard } from '@/core';
import { CurrentUser, JwtAuthGuard, Public } from '@/modules/identity/auth';
import { DEFAULT_PRESIGN_SIZE_BYTES } from '../files.constant';
import {
  FilesBatchPartUrlsDto,
  FilesCompleteMultipartDto,
  FilesCompletePresignDto,
  FilesInitiateMultipartDto,
  FilesPresignDto,
} from '../files.dto';
import { FilesFacade } from '../files.facade';
import {
  applyBinaryHeaders,
  extractMultipartSingleFile,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_PUBLIC_UPLOAD_BYTES,
} from './files-http.helper';

@ApiTags('Files')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(private readonly filesFacade: FilesFacade) {}

  private requireUserId(userId?: string): string {
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }
    return userId;
  }

  @Post('upload')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-presign', keyType: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a platform binary asset directly via multipart/form-data',
  })
  async uploadDirect(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    const actorId = this.requireUserId(userId);
    const { buffer, filename, mimeType, fields } =
      await extractMultipartSingleFile(req, MAX_DIRECT_UPLOAD_BYTES);
    const resolvedSpaceId = await this.filesFacade.assertSpaceAccess(
      actorId,
      fields.spaceId,
    );

    const res = await this.filesFacade.uploadFile({
      userId: actorId,
      filename,
      buffer,
      mimeType,
      spaceId: resolvedSpaceId,
    });

    return {
      id: res.fileId,
      fileId: res.fileId,
      blobId: res.blobId,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
      url: res.url,
    };
  }

  @Post('public/upload')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-presign', keyType: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a public image asset (avatar, cover, icon)',
  })
  async uploadPublicAsset(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    this.requireUserId(userId);
    const { buffer, filename, mimeType } = await extractMultipartSingleFile(
      req,
      MAX_PUBLIC_UPLOAD_BYTES,
    );

    return this.filesFacade.uploadPublicImage({
      buffer,
      filename,
      mimeType,
    });
  }

  @Post('presign')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-presign', keyType: 'user' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned upload URL for FilesModule' })
  async presign(
    @CurrentUser('id') userId: string,
    @Body() dto: FilesPresignDto,
  ) {
    const actorId = this.requireUserId(userId);
    const resolvedSpaceId = await this.filesFacade.assertSpaceAccess(
      actorId,
      dto.spaceId,
    );

    const res = await this.filesFacade.presignUpload({
      userId: actorId,
      spaceId: resolvedSpaceId,
      filename: dto.filename,
      mimeType: dto.mimeType || 'application/octet-stream',
      sizeBytes: dto.sizeBytes ?? DEFAULT_PRESIGN_SIZE_BYTES,
      contentHash: dto.contentHash,
    });

    return {
      uploadUrl: res.uploadUrl || '',
      storageKey: res.storageKey,
      fileUuid: res.fileUuid || res.blob?.id || '',
      expiresIn: res.expiresIn,
      deduplicated: res.deduplicated,
      ...(res.blob
        ? {
            fileId: res.blob.id,
            url: res.url,
            filename: res.filename || res.cleanFilename,
            size: res.size ?? Number(res.blob.sizeBytes),
            mimeType: res.mimeType,
          }
        : {}),
    };
  }

  @Post('presign/complete')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-complete', keyType: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Complete and finalize a presigned upload' })
  async completePresigned(
    @CurrentUser('id') userId: string,
    @Body() dto: FilesCompletePresignDto,
  ) {
    const actorId = this.requireUserId(userId);
    const resolvedSpaceId = await this.filesFacade.assertSpaceAccess(
      actorId,
      dto.spaceId,
    );

    const result = await this.filesFacade.completePresignedUpload({
      userId: actorId,
      spaceId: resolvedSpaceId,
      storageKey: dto.storageKey,
      filename: dto.filename,
      sizeBytes: dto.sizeBytes,
      mimeType: dto.mimeType,
      contentHash: dto.contentHash,
    });

    return {
      id: result.fileId,
      fileId: result.fileId,
      blobId: result.blobId,
      url: result.url,
      filename: result.filename,
      size: result.size,
      mimeType: result.mimeType,
    };
  }

  @Post('multipart/initiate')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-presign', keyType: 'user' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Initiate a resumable multipart upload session for FilesModule',
  })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: FilesInitiateMultipartDto,
  ) {
    const actorId = this.requireUserId(userId);
    const totalSize = dto.totalSize ?? dto.sizeBytes;
    if (!totalSize || totalSize <= 0) {
      throw new BadRequestException(
        'Total file size is required and must be greater than 0',
      );
    }
    const resolvedSpaceId = await this.filesFacade.assertSpaceAccess(
      actorId,
      dto.spaceId,
    );

    const res = await this.filesFacade.initiateMultipart({
      userId: actorId,
      spaceId: resolvedSpaceId,
      filename: dto.filename,
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize,
      expectedHash: dto.expectedHash,
    });

    return {
      sessionId: res.sessionId,
      uploadId: res.uploadId,
      partSize: res.partSize,
      totalParts: res.totalParts,
      deduplicated: res.deduplicated,
      ...(res.blob
        ? {
            fileId: res.fileId || res.blob.id,
            url: res.url,
            filename: res.filename || res.cleanFilename,
            size: res.size ?? Number(res.blob.sizeBytes),
          }
        : {}),
    };
  }

  @Get('multipart/:sessionId/part-url')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-parts', keyType: 'user' })
  @ApiOperation({ summary: 'Generate presigned part URL via query parameter' })
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumber: string,
  ): Promise<{ partNumber: number; uploadUrl: string }> {
    const actorId = this.requireUserId(userId);
    if (!sessionId || !sessionId.trim()) {
      throw new BadRequestException('Session ID is required');
    }
    const parsedPartNumber = Number(partNumber);
    if (!Number.isInteger(parsedPartNumber) || parsedPartNumber < 1) {
      throw new BadRequestException('Invalid partNumber parameter');
    }
    const uploadUrl = await this.filesFacade.getMultipartPartUrl(
      sessionId,
      parsedPartNumber,
      { userId: actorId },
    );
    return { partNumber: parsedPartNumber, uploadUrl };
  }

  @Post('multipart/:sessionId/part-urls')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-parts', keyType: 'user' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch generate presigned upload URLs for multiple parts',
  })
  async batchMultipartPartUrls(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: FilesBatchPartUrlsDto,
  ) {
    const actorId = this.requireUserId(userId);
    const parts = await this.filesFacade.presignMultipartParts(
      sessionId,
      dto.partNumbers,
      { userId: actorId },
    );
    return { parts };
  }

  @Post('multipart/complete')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-complete', keyType: 'user' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a multipart upload session and finalize CAS blob',
  })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: FilesCompleteMultipartDto,
  ) {
    const actorId = this.requireUserId(userId);
    const res = await this.filesFacade.completeMultipart({
      sessionId: dto.sessionId,
      parts: dto.parts,
      actor: { userId: actorId },
    });
    return {
      id: res.fileId,
      fileId: res.fileId,
      blobId: res.blobId,
      url: res.url,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
    };
  }

  @Delete('multipart/:sessionId')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-complete', keyType: 'user' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort an active multipart upload session' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
  ) {
    const actorId = this.requireUserId(userId);
    await this.filesFacade.abortMultipart(sessionId, { userId: actorId });
    return { aborted: true, success: true };
  }

  @Get('quota')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-download', keyType: 'user' })
  @ApiOperation({
    summary: 'Get storage quota usage metrics for personal or project space',
  })
  async getQuota(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.filesFacade.getQuotaSummary(
      this.requireUserId(userId),
      spaceId,
    );
  }

  @Get('objects/*')
  @Public()
  @UserRateLimit({ bucket: 'files-download', keyType: 'user-or-ip' })
  @BypassEnvelope()
  @ApiOperation({
    summary: 'Stream public platform assets or signed derivative thumbnails',
  })
  async streamObjectByKey(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const rawUrl = req.raw?.url || req.url || '';
    const prefix = '/api/v1/files/objects/';
    const idx = rawUrl.indexOf(prefix);
    const params = req.params as { '*'?: string } | undefined;
    const rawKey =
      idx !== -1
        ? rawUrl.slice(idx + prefix.length).split('?')[0]
        : params?.['*'] || '';

    const reqAuth = req as FastifyRequest & {
      user?: { id?: string; sub?: string };
      query?: { exp?: string; sig?: string };
    };

    try {
      const output = await this.filesFacade.resolveAuthorizedObjectStream({
        rawKey,
        userId: reqAuth.user?.id || reqAuth.user?.sub,
        exp: reqAuth.query?.exp,
        sig: reqAuth.query?.sig,
        rangeHeader:
          typeof req.headers?.range === 'string'
            ? req.headers.range
            : undefined,
      });

      res.status(output.statusCode);
      applyBinaryHeaders(res, {
        mimeType: output.mimeType,
        filename: output.filename,
        isDownload: req.url.includes('/download'),
        contentLength: output.contentLength,
        contentRange: output.contentRange,
        cacheControl: output.cacheControl,
        varyHeader: 'Range',
      });

      return res.send(output.stream);
    } catch (err: unknown) {
      const status =
        err instanceof HttpException ? err.getStatus() : HttpStatus.NOT_FOUND;
      const message =
        err instanceof HttpException ? err.message : 'Object not found';
      if (status === Number(HttpStatus.NOT_FOUND)) {
        this.logger.warn(
          `Failed to stream object ${rawKey}: ${(err as Error)?.message}`,
        );
      }
      return res.status(status).send({ statusCode: status, message });
    }
  }

  @Get(':blobId/download-url')
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ bucket: 'files-download', keyType: 'user' })
  @ApiOperation({
    summary: 'Issue direct signed download URL (R2 Presigned GET) for a blob',
  })
  async getDirectDownloadUrl(
    @CurrentUser('id') userId: string,
    @Param('blobId') blobId: string,
    @Query('filename') filename?: string,
  ) {
    return this.filesFacade.getAuthorizedDownloadUrl(
      this.requireUserId(userId),
      blobId,
      filename,
    );
  }

  @Get([':blobId/content', ':blobId/download'])
  @Public()
  @UserRateLimit({ bucket: 'files-download', keyType: 'user-or-ip' })
  @BypassEnvelope()
  @ApiOperation({
    summary: 'Stream or redirect authorized blob content with ETag and Range',
  })
  async streamBlobContent(
    @Param('blobId') blobId: string,
    @Query('filename') queryFilename: string | undefined,
    @Query('download') queryDownload: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('exp') queryExp?: string,
    @Query('sig') querySig?: string,
    @Query('redirect') queryRedirect?: string,
  ) {
    const reqAuth = req as FastifyRequest & {
      user?: { id?: string; sub?: string };
    };
    const isDownload =
      req.url.includes('/download') ||
      queryDownload === 'true' ||
      queryDownload === '1';

    const outcome = await this.filesFacade.resolveAuthorizedBlobContent({
      blobId,
      userId: reqAuth.user?.id || reqAuth.user?.sub,
      exp: queryExp,
      sig: querySig,
      filename: queryFilename,
      isDownload,
      redirect:
        queryRedirect === '1' || queryRedirect === 'true'
          ? true
          : queryRedirect === '0' || queryRedirect === 'false'
            ? false
            : undefined,
      ifNoneMatch:
        typeof req.headers?.['if-none-match'] === 'string'
          ? req.headers['if-none-match']
          : undefined,
      rangeHeader:
        typeof req.headers?.range === 'string' ? req.headers.range : undefined,
    });

    if (outcome.kind === 'redirect') {
      return res
        .status(HttpStatus.FOUND)
        .header('Location', outcome.location)
        .header('Cache-Control', 'private, max-age=60')
        .send();
    }

    if (outcome.kind === 'not-modified') {
      res.status(HttpStatus.NOT_MODIFIED);
      res.header('ETag', outcome.etag);
      res.header('Cache-Control', 'private, max-age=31536000, immutable');
      res.header('Vary', 'If-None-Match');
      return res.send();
    }

    res.status(outcome.statusCode);
    applyBinaryHeaders(res, {
      mimeType: outcome.mimeType,
      filename: outcome.filename,
      isDownload: outcome.isDownload,
      contentLength: outcome.contentLength,
      contentRange: outcome.contentRange,
      etag: outcome.etag,
      cacheControl: 'private, max-age=31536000, immutable',
      varyHeader: 'If-None-Match, Range',
    });

    return res.send(outcome.stream);
  }
}
