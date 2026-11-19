import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BypassEnvelope } from '@/core';
import { CurrentUser, JwtAuthGuard, Public } from '@/modules/identity/auth';
import {
  cleanUuid,
  inferMimeType,
  isDangerousInlineMime,
  isValidUuid,
  sanitizeFilename,
  streamToBuffer,
} from '../domain/files.policy';
import { FilesCompletePresignDto, FilesPresignDto } from '../files.dto';
import { FilesFacade } from '../files.facade';
import { BlobService } from '../services/blob.service';

const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;

interface MultipartStreamRequest extends Omit<
  FastifyRequest,
  'isMultipart' | 'parts'
> {
  isMultipart?: () => boolean;
  parts: () => AsyncIterable<{
    type: string;
    fieldname: string;
    filename?: string;
    mimetype?: string;
    value?: unknown;
    file?: AsyncIterable<Buffer>;
  }>;
}

@ApiTags('Files')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(
    private readonly filesFacade: FilesFacade,
    private readonly blobService: BlobService,
  ) {}

  private applyBinaryHeaders(
    res: FastifyReply,
    options: {
      mimeType: string;
      filename: string;
      isDownload: boolean;
      contentLength?: number;
      contentRange?: string;
      etag?: string;
      cacheControl: string;
      varyHeader: string;
    },
  ): void {
    const cleanName = sanitizeFilename(options.filename);
    const isDangerous = isDangerousInlineMime(options.mimeType);
    const disposition =
      isDangerous || options.isDownload ? 'attachment' : 'inline';

    res.header('Content-Type', options.mimeType);
    if (options.contentLength !== undefined) {
      res.header('Content-Length', options.contentLength);
    }
    res.header('Accept-Ranges', 'bytes');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('Cache-Control', options.cacheControl);
    res.header('Vary', options.varyHeader);
    if (options.etag) {
      res.header('ETag', options.etag);
    }
    if (options.contentRange) {
      res.header('Content-Range', options.contentRange);
    }
    if (isDangerous) {
      res.header('Content-Security-Policy', "default-src 'none'; sandbox");
    }

    const encoded = encodeURIComponent(cleanName);
    res.header(
      'Content-Disposition',
      `${disposition}; filename="${cleanName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`,
    );
  }

  private async resolveBlobMimeType(
    storageKey: string,
    sizeBytes: bigint,
  ): Promise<string> {
    try {
      const stat = await this.blobService.stat(storageKey);
      if (stat?.mimeType && stat.mimeType !== 'application/octet-stream') {
        return stat.mimeType;
      }
    } catch {
      // Fallback to header sniffing below
    }

    if (sizeBytes > 0n) {
      try {
        const end = Math.min(31, Number(sizeBytes) - 1);
        const { stream } = await this.blobService.getStream(storageKey, {
          start: 0,
          end,
        });
        const headerBytes = await streamToBuffer(
          stream as AsyncIterable<Buffer>,
        );
        return inferMimeType({ headerBytes });
      } catch {
        // Fallback to octet-stream when header sniff fails
      }
    }

    return 'application/octet-stream';
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a platform binary asset directly via multipart/form-data',
  })
  async uploadDirect(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }
    const multipartReq = req as unknown as MultipartStreamRequest;
    if (
      typeof multipartReq.isMultipart !== 'function' ||
      !multipartReq.isMultipart()
    ) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    let buffer: Buffer | undefined;
    let filename = 'uploaded-file';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, string> = {};

    for await (const part of multipartReq.parts()) {
      if (part.type === 'file') {
        filename = part.filename || filename;
        mimeType = part.mimetype || mimeType;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        if (part.file) {
          for await (const chunk of part.file) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > MAX_DIRECT_UPLOAD_BYTES) {
              throw new PayloadTooLargeException(
                'Direct upload exceeds 100MB limit',
              );
            }
            chunks.push(buf);
          }
        }
        buffer = Buffer.concat(chunks);
      } else if (part.fieldname && part.value !== undefined) {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!buffer) {
      throw new BadRequestException('No file uploaded');
    }

    const chosenName =
      filename && filename !== 'blob'
        ? filename
        : fields.fileName || fields.filename || fields.name || 'uploaded-file';
    const projectId =
      cleanUuid(fields.spaceId) ?? cleanUuid(fields.projectId) ?? undefined;

    const res = await this.filesFacade.uploadFile({
      userId,
      filename: chosenName,
      buffer,
      mimeType,
      projectId,
    });

    return {
      id: res.fileId,
      fileId: res.fileId,
      blobId: res.blobId,
      filename: res.filename,
      size: res.size,
      mimeType: res.mimeType,
      url: res.url,
      file: {
        id: res.fileId,
        filename: res.filename,
        size: res.size,
        url: res.url,
      },
    };
  }

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned upload URL for FilesModule' })
  async presign(
    @CurrentUser('id') userId: string,
    @Body() dto: FilesPresignDto,
  ) {
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }

    const sizeBytes = dto.sizeBytes ?? dto.size ?? 10 * 1024 * 1024;
    const projectId =
      cleanUuid(dto.spaceId) ?? cleanUuid(dto.projectId) ?? undefined;

    return this.filesFacade.getPresignedUploadUrl({
      userId,
      projectId,
      filename: dto.filename,
      mimeType: dto.mimeType || dto.contentType || 'application/octet-stream',
      sizeBytes,
      contentHash: dto.contentHash,
    });
  }

  @Post('presign/complete')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Complete and finalize a presigned upload' })
  async completePresigned(
    @CurrentUser('id') userId: string,
    @Body() dto: FilesCompletePresignDto,
  ) {
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }

    const projectId =
      cleanUuid(dto.spaceId) ?? cleanUuid(dto.projectId) ?? undefined;
    const result = await this.filesFacade.completePresignedUpload({
      userId,
      projectId,
      storageKey: dto.storageKey,
      filename: dto.filename,
      sizeBytes: dto.sizeBytes ?? dto.size,
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

  @Get('objects/*')
  @Public()
  @BypassEnvelope()
  @ApiOperation({ summary: 'Stream public platform object by storage key' })
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

    if (!rawKey) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .send({ statusCode: 404, message: 'Object key is required' });
    }

    const key = decodeURIComponent(rawKey);
    const normalizedKey = key.replace(/\\/g, '/');
    if (
      normalizedKey.includes('..') ||
      normalizedKey.startsWith('/') ||
      normalizedKey.startsWith('backups/') ||
      normalizedKey.startsWith('private/') ||
      normalizedKey.startsWith('config/') ||
      normalizedKey.startsWith('uploads/staging/')
    ) {
      return res.status(HttpStatus.FORBIDDEN).send({
        statusCode: 403,
        message: 'Access to restricted storage path is forbidden',
      });
    }

    const rangeHeader =
      typeof req.headers?.range === 'string' ? req.headers.range : undefined;

    try {
      const output = await this.filesFacade.streamByKey(key, rangeHeader);
      const mimeType = inferMimeType({ filename: key });
      const basename = key.split('/').pop() || 'file';

      res.status(
        output.contentRange ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK,
      );
      this.applyBinaryHeaders(res, {
        mimeType,
        filename: basename,
        isDownload: req.url.includes('/download'),
        contentLength: output.contentLength,
        contentRange: output.contentRange,
        cacheControl: 'public, max-age=300',
        varyHeader: 'Range',
      });

      return res.send(output.stream);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to stream object ${key}: ${(err as Error)?.message}`,
      );
      return res
        .status(HttpStatus.NOT_FOUND)
        .send({ statusCode: 404, message: 'Object not found' });
    }
  }

  @Get([':blobId/content', ':blobId/download'])
  @Public()
  @BypassEnvelope()
  @ApiOperation({
    summary: 'Stream content-addressed blob content with ETag and byte-range',
  })
  async streamBlobContent(
    @Param('blobId') blobId: string,
    @Query('filename') queryFilename: string | undefined,
    @Query('download') queryDownload: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!isValidUuid(blobId)) {
      throw new NotFoundException('File blob not found');
    }

    const blob = await this.blobService.findBlobById(blobId);
    if (!blob || !blob.isReady()) {
      throw new NotFoundException('File blob not found');
    }

    const etag = `"${blob.contentHash.toHex()}"`;
    const ifNoneMatch =
      typeof req.headers?.['if-none-match'] === 'string'
        ? req.headers['if-none-match']
        : undefined;
    const rangeHeader =
      typeof req.headers?.range === 'string' ? req.headers.range : undefined;

    if (ifNoneMatch && ifNoneMatch === etag && !rangeHeader) {
      res.status(HttpStatus.NOT_MODIFIED);
      res.header('ETag', etag);
      res.header('Cache-Control', 'public, max-age=31536000, immutable');
      res.header('Vary', 'If-None-Match');
      return res.send();
    }

    const mimeType = await this.resolveBlobMimeType(
      blob.s3Key.value(),
      blob.sizeBytes,
    );
    const streamRes = await this.filesFacade.streamBlob(blob, {
      rangeHeader,
      ifNoneMatch,
      mimeType,
      filename: queryFilename ? sanitizeFilename(queryFilename) : blob.id,
    });

    if (streamRes.statusCode === Number(HttpStatus.NOT_MODIFIED)) {
      res.status(HttpStatus.NOT_MODIFIED);
      res.header('ETag', etag);
      res.header('Cache-Control', 'public, max-age=31536000, immutable');
      res.header('Vary', 'If-None-Match');
      return res.send();
    }

    const isDownload =
      req.url.includes('/download') ||
      queryDownload === 'true' ||
      queryDownload === '1';

    res.status(streamRes.statusCode);
    this.applyBinaryHeaders(res, {
      mimeType: streamRes.mimeType,
      filename: streamRes.filename,
      isDownload,
      contentLength: streamRes.contentLength,
      contentRange: streamRes.contentRange,
      etag: streamRes.etag || etag,
      cacheControl: 'public, max-age=31536000, immutable',
      varyHeader: 'If-None-Match, Range',
    });

    return res.send(streamRes.stream);
  }
}
