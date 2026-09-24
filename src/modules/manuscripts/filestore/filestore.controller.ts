/**
 * filestore/filestore.controller.ts
 * Inbound Driving Adapter exposing Overleaf-compatible HTTP endpoints for binary assets.
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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UploadManuscriptFileUseCase } from './core/use-cases/upload-manuscript-file.use-case';
import { StreamManuscriptFileUseCase } from './core/use-cases/stream-manuscript-file.use-case';
import { GetManuscriptFileHeadUseCase } from './core/use-cases/get-manuscript-file-head.use-case';
import { DeleteManuscriptFileUseCase } from './core/use-cases/delete-manuscript-file.use-case';
import { GetSignedDownloadUrlUseCase } from './core/use-cases/get-signed-download-url.use-case';
import { ManuscriptFileResponseDto } from './dto/file-response.dto';
import { FileNotFoundException } from './core/domain/exceptions/file-not-found.exception';
import { InvalidByteRangeException } from './core/domain/exceptions/invalid-byte-range.exception';

@ApiTags('Manuscripts - Filestore & Assets')
@Controller([
  'api/v1/manuscripts/projects/:projectId/files',
  'manuscripts/projects/:projectId/files',
  'project/:projectId/file',
])
export class FilestoreController {
  constructor(
    private readonly uploadUseCase: UploadManuscriptFileUseCase,
    private readonly streamUseCase: StreamManuscriptFileUseCase,
    private readonly headUseCase: GetManuscriptFileHeadUseCase,
    private readonly deleteUseCase: DeleteManuscriptFileUseCase,
    private readonly signedUrlUseCase: GetSignedDownloadUrlUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async uploadFile(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @Query('name') queryName?: string,
  ): Promise<ManuscriptFileResponseDto> {
    let filename = queryName || 'unnamed.bin';
    let mimeType = 'application/octet-stream';
    let dataStream: Readable;

    // Check if multipart
    const isMultipart =
      typeof (req as any).isMultipart === 'function'
        ? (req as any).isMultipart()
        : Boolean((req as any).isMultipart);

    if (isMultipart) {
      const part = await (req as any).file();
      if (!part) {
        throw new BadRequestException('No file found in multipart upload.');
      }
      filename = queryName || part.filename || filename;
      mimeType = part.mimetype || mimeType;
      dataStream = part.file;
    } else {
      // Direct raw binary stream from request body
      dataStream = req.raw;
      const contentType = req.headers['content-type'];
      if (contentType) {
        mimeType = contentType.split(';')[0].trim();
      }
    }

    const savedFile = await this.uploadUseCase.execute({
      projectId,
      name: filename,
      mimeType,
      stream: dataStream,
    });

    return ManuscriptFileResponseDto.fromEntity(savedFile);
  }

  @Head(':fileId')
  public async getFileHead(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const { file } = await this.headUseCase.execute({ projectId, fileId });

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

  @Get(':fileId')
  public async streamFile(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.streamUseCase.execute({
        projectId,
        fileId,
        rangeHeader,
      });

      const { file, stream, byteRange, isPartialContent, contentLength } = result;

      // Defense in depth: Mobile Safari HTML execution defense (Overleaf Parity)
      const isMobileSafari =
        userAgent && (userAgent.includes('iPhone') || userAgent.includes('iPad'));
      const isHtml =
        file.name.endsWith('.html') || file.name.endsWith('.htm') || file.name.endsWith('.xhtml');

      if (isMobileSafari && isHtml) {
        res.header('Content-Type', 'text/plain; charset=utf-8');
      } else {
        res.header('Content-Type', file.mimeType);
      }

      // Headers for caching and downloading
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

      // Zero-RAM backpressure pipeline stream out to socket
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
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteFile(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
  ): Promise<void> {
    try {
      await this.deleteUseCase.execute({ projectId, fileId });
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
  ): Promise<{ signedUrl: string | null }> {
    try {
      const ttl = expiresIn ? parseInt(expiresIn, 10) : 3600;
      const signedUrl = await this.signedUrlUseCase.execute({
        projectId,
        fileId,
        expiresInSeconds: ttl,
      });
      return { signedUrl };
    } catch (err) {
      if (err instanceof FileNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }
}
