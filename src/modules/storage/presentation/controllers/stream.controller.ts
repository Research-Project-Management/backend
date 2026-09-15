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
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { Public } from '@/modules/iam/authn/decorators/public.decorator';
import { StreamBinaryUseCase } from '../../application/use-cases/stream/stream-binary.use-case';
import { R2Service } from '../../infrastructure/drivers/r2.service';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_DRIVER,
} from '../../storage.tokens';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../domain/ports/storage-blob.repository.port';
import { IStorageDriver } from '../../domain/ports/storage-driver.port';
import { ZipPackager } from '../../infrastructure/utils/zip-packager';
import { StorageNode } from '../../domain/entities/storage-node.entity';

@ApiTags('Storage & Streaming')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
export class StreamController {
  constructor(
    private readonly streamBinaryUseCase: StreamBinaryUseCase,
    private readonly r2Service: R2Service,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Inject(STORAGE_DRIVER)
    private readonly driver: IStorageDriver,
  ) {}

  @Get([
    ':fileId/content',
    ':fileId/stream',
    'stream/:fileId',
    ':fileId/download',
    ':fileId/raw',
  ])
  @Public() // Allow direct stream (authenticated via session/ticket or token in query)
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
      const result = await this.streamBinaryUseCase.execute(
        fileId,
        rangeHeader,
      );

      res.status(result.statusCode);
      res.header('Content-Type', result.mimeType);
      res.header('Content-Length', result.contentLength);
      res.header('Accept-Ranges', 'bytes');
      res.header('X-Content-Type-Options', 'nosniff');

      if (result.contentRange) {
        res.header('Content-Range', result.contentRange);
      }

      // RFC 6266 Unicode-safe Content-Disposition
      const encoded = encodeURIComponent(result.filename);
      res.header(
        'Content-Disposition',
        `inline; filename="${result.filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`,
      );

      return res.send(result.stream);
    } catch (err: any) {
      if (err instanceof NotFoundException) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .send({ statusCode: 404, message: err.message });
      }
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ statusCode: 500, message: err.message });
    }
  }

  @Get('r2/*')
  @Public()
  @ApiOperation({
    summary: 'Stream R2 stored file by storage key (Editor compatibility)',
  })
  async streamR2File(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const rawUrl = req.raw?.url || req.url || '';
    const prefix = '/api/files/r2/';
    const idx = rawUrl.indexOf(prefix);
    const rawKey =
      idx !== -1
        ? rawUrl.slice(idx + prefix.length).split('?')[0]
        : (req.params as any)?.['*'] || '';

    if (!rawKey) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .send({ statusCode: 404, message: 'Storage key is required' });
    }

    const key = decodeURIComponent(rawKey);
    const rangeHeader = req.headers?.range;

    try {
      const output = await this.r2Service.getObjectStream(key, rangeHeader);
      if (!output?.Body) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .send({ statusCode: 404, message: 'File not found in storage' });
      }

      const contentType = output.ContentType || 'application/octet-stream';
      res.header('Content-Type', contentType);
      res.header('Accept-Ranges', 'bytes');
      res.header('X-Content-Type-Options', 'nosniff');

      if (output.ContentLength !== undefined) {
        res.header('Content-Length', output.ContentLength);
      }
      if (output.ContentRange) {
        res.status(HttpStatus.PARTIAL_CONTENT);
        res.header('Content-Range', output.ContentRange);
      } else {
        res.status(HttpStatus.OK);
      }

      return res.send(output.Body);
    } catch {
      return res
        .status(HttpStatus.NOT_FOUND)
        .send({ statusCode: 404, message: 'File not found in storage' });
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
  ) {
    const ids = Array.isArray(idsParam)
      ? idsParam
      : (idsParam || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    return this.processBulkZip(ids, res);
  }

  @Post('bulk-download')
  @Public()
  @ApiOperation({
    summary: 'Bulk download multiple files via POST as a ZIP archive',
  })
  async bulkDownloadPost(
    @Body() dto: { ids?: string[] },
    @Res() res: FastifyReply,
  ) {
    return this.processBulkZip(dto?.ids || [], res);
  }

  private async processBulkZip(rawIds: string[], res: FastifyReply) {
    if (rawIds.length === 0) {
      return res.status(HttpStatus.BAD_REQUEST).send({
        statusCode: 400,
        message: 'No file IDs provided for bulk download',
      });
    }

    const zip = new ZipPackager();

    const addNodeToZip = async (node: StorageNode, currentPath = '') => {
      if (node.isTrashed()) return;

      if (node.isFolder) {
        const folderPath = currentPath
          ? `${currentPath}/${node.name}`
          : node.name;
        const children = await this.nodeRepo.list({
          userId: node.authorId,
          projectId: node.projectId,
          parentId: node.id,
          limit: 1000,
        });
        for (const child of children.nodes) {
          await addNodeToZip(child, folderPath);
        }
      } else if (node.blobId) {
        const blob = await this.blobRepo.findById(node.blobId);
        if (blob) {
          const { stream } = await this.driver.getStream(blob.s3Key.value());
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const buf = Buffer.concat(chunks);
          const entryName = currentPath
            ? `${currentPath}/${node.name}`
            : node.name;
          zip.addFile(entryName, buf, node.updatedAt);
        }
      }
    };

    for (const id of rawIds) {
      const node = await this.nodeRepo.findById(id);
      if (node) {
        await addNodeToZip(node);
      }
    }

    const zipBuffer = zip.build();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `flux_research_export_${timestamp}.zip`;

    res.status(HttpStatus.OK);
    res.header('Content-Type', 'application/zip');
    res.header('Content-Length', zipBuffer.length);
    res.header('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(zipBuffer);
  }
}
