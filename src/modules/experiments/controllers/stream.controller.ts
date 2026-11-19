import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Req,
  Res,
  UseGuards,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Public, CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import { isDangerousInlineMime } from '@/modules/files';
import { FileDownloadedEvent } from '../domain/experiments.event';
import { StreamService } from '../services/stream.service';

interface StreamRequest extends FastifyRequest {
  user?: { id?: string; sub?: string };
  params: {
    fileId?: string;
    '*'?: string;
  };
  query: {
    download?: string;
  };
}

@ApiTags('Experiments')
@Controller('api/v1/experiments/files')
@UseGuards(JwtAuthGuard)
export class StreamController {
  private readonly logger = new Logger(StreamController.name);

  constructor(
    private readonly streamService: StreamService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private sendNotModified(
    res: FastifyReply,
    etag: string | undefined,
    varyHeader: string,
  ) {
    res.status(HttpStatus.NOT_MODIFIED);
    if (etag) {
      res.header('ETag', etag);
    }
    res.header('Cache-Control', 'private, no-cache, must-revalidate');
    res.header('Vary', varyHeader);
    return res.send();
  }

  private applyStreamSecurityHeaders(
    res: FastifyReply,
    options: {
      contentType: string;
      filename: string;
      isDownloadEndpoint: boolean;
      etag?: string;
      varyHeader: string;
      contentLength?: number;
      contentRange?: string;
    },
  ): void {
    const isDangerous = isDangerousInlineMime(options.contentType);
    const dispositionType =
      isDangerous || options.isDownloadEndpoint ? 'attachment' : 'inline';

    res.header('Content-Type', options.contentType);
    if (options.contentLength !== undefined) {
      res.header('Content-Length', options.contentLength);
    }
    res.header('Accept-Ranges', 'bytes');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    if (options.etag) {
      res.header('ETag', options.etag);
    }
    res.header('Cache-Control', 'private, no-cache, must-revalidate');
    res.header('Vary', options.varyHeader);

    if (isDangerous) {
      res.header('Content-Security-Policy', "default-src 'none'; sandbox");
    }

    if (options.contentRange) {
      res.header('Content-Range', options.contentRange);
    }

    const encoded = encodeURIComponent(options.filename);
    res.header(
      'Content-Disposition',
      `${dispositionType}; filename="${options.filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`,
    );
  }

  @Get([':fileId/content', ':fileId/download'])
  @Public()
  @ApiOperation({
    summary: 'Stream binary content with RFC 7233 Range support',
  })
  async streamFile(
    @Param('fileId') fileId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const rangeHeader = req.headers?.range;

    try {
      const streamReq = req as unknown as StreamRequest;
      const currentUserId = streamReq.user?.id;
      await this.streamService.verifyReadAccess(fileId, currentUserId);

      const ifNoneMatch = req.headers?.['if-none-match'];
      const result = await this.streamService.stream(
        fileId,
        rangeHeader,
        ifNoneMatch,
      );

      if (
        result.statusCode === Number(HttpStatus.NOT_MODIFIED) ||
        (result.etag &&
          ifNoneMatch &&
          ifNoneMatch === result.etag &&
          !rangeHeader)
      ) {
        return this.sendNotModified(
          res,
          result.etag,
          'Authorization, Cookie, If-None-Match',
        );
      }

      const isDownloadEndpoint =
        req.url.includes('/download') ||
        streamReq.query?.download === 'true' ||
        streamReq.query?.download === '1';

      res.status(result.statusCode);
      this.applyStreamSecurityHeaders(res, {
        contentType: result.mimeType,
        filename: result.filename,
        isDownloadEndpoint,
        etag: result.etag,
        varyHeader: 'Authorization, Cookie, If-None-Match',
        contentLength: result.contentLength,
        contentRange: result.contentRange,
      });

      this.eventEmitter?.emit(
        'file.downloaded',
        new FileDownloadedEvent(
          fileId,
          result.filename,
          result.mimeType,
          result.contentLength,
          streamReq.user?.id || null,
          req.ip,
        ),
      );

      return res.send(result.stream);
    } catch (err: unknown) {
      if (err instanceof NotFoundException) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .send({ statusCode: 404, message: err.message });
      }
      if (err instanceof ForbiddenException) {
        return res
          .status(HttpStatus.FORBIDDEN)
          .send({ statusCode: 403, message: err.message });
      }
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ statusCode: 500, message });
    }
  }

  @Get('bulk-download')
  @Public()
  @ApiOperation({
    summary: 'Bulk download multiple files as a single streaming ZIP archive',
  })
  async bulkDownloadGet(
    @Query('ids') idsParam: string,
    @Res() res: FastifyReply,
    @CurrentUser('id') userId?: string,
  ) {
    const ids = Array.isArray(idsParam)
      ? idsParam
      : (idsParam || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    return this.processBulkZip(ids, res, userId);
  }

  @Post('bulk-download')
  @Public()
  @ApiOperation({
    summary: 'Bulk download multiple files via POST as a ZIP archive',
  })
  async bulkDownloadPost(
    @Body() dto: { ids?: string[] },
    @Res() res: FastifyReply,
    @CurrentUser('id') userId?: string,
  ) {
    return this.processBulkZip(dto?.ids || [], res, userId);
  }

  private async processBulkZip(
    rawIds: string[],
    res: FastifyReply,
    userId?: string,
  ) {
    if (rawIds.length === 0) {
      return res.status(HttpStatus.BAD_REQUEST).send({
        statusCode: 400,
        message: 'No file IDs provided for bulk download',
      });
    }

    try {
      for (const id of rawIds) {
        await this.streamService.verifyReadAccess(id, userId);
      }
    } catch (err: unknown) {
      if (err instanceof ForbiddenException) {
        return res.status(HttpStatus.FORBIDDEN).send({
          statusCode: 403,
          message: err.message,
        });
      }
      if (err instanceof NotFoundException) {
        return res.status(HttpStatus.NOT_FOUND).send({
          statusCode: 404,
          message: err.message,
        });
      }
      throw err;
    }

    const zipBuffer = await this.streamService.buildBulkZipArchive(rawIds);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `flux_research_export_${timestamp}.zip`;

    res.status(HttpStatus.OK);
    res.header('Content-Type', 'application/zip');
    res.header('Content-Length', zipBuffer.length);
    res.header('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(zipBuffer);
  }
}
