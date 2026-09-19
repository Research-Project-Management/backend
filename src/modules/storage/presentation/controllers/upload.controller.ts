import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Inject,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { UploadDirectUseCase } from '../../application/use-cases/upload/upload-direct.use-case';
import { PresignUploadUseCase } from '../../application/use-cases/upload/presign-upload.use-case';
import { CompletePresignUseCase } from '../../application/use-cases/upload/complete-presign.use-case';
import { MultipartUploadUseCase } from '../../application/use-cases/upload/multipart-upload.use-case';
import { PresignDto, CompletePresignedDto } from '../dto/file.dto';
import {
  InitiateMultipartDto,
  CompleteMultipartDto,
} from '../dto/multipart.dto';

import { STORAGE_NODE_REPOSITORY } from '../../storage.tokens';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { StorageNode } from '../../domain/entities/storage-node.entity';
import { FileScope } from '../../domain/value-objects/file-scope.vo';
import * as crypto from 'crypto';

@ApiTags('Storage & Uploads')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadDirectUseCase: UploadDirectUseCase,
    private readonly presignUploadUseCase: PresignUploadUseCase,
    private readonly completePresignUseCase: CompletePresignUseCase,
    private readonly multipartUploadUseCase: MultipartUploadUseCase,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
  ) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for direct upload' })
  async presign(@CurrentUser('id') userId: string, @Body() dto: PresignDto) {
    return this.presignUploadUseCase.execute({
      userId,
      filename: dto.filename,
      mimeType: dto.mimeType || dto.contentType || 'application/octet-stream',
      sizeBytes: dto.size || 10 * 1024 * 1024,
    });
  }

  @Post('presign/complete')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register and finalize a direct presigned upload' })
  async completePresigned(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignedDto,
  ) {
    const result = await this.completePresignUseCase.execute({
      userId,
      storageKey: dto.storageKey,
      filename: dto.filename,
      sizeBytes: dto.size ?? dto.sizeBytes,
      mimeType: dto.mimeType,
      projectId: dto.projectId,
      parentId: dto.parentId,
    });

    return {
      ...result,
      id: result.fileId,
      file: {
        id: result.fileId,
        filename: result.filename,
        size: result.size,
        mimeType: result.mimeType,
        url: result.url,
      },
    };
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Direct upload endpoint using multipart/form-data or JSON metadata',
  })
  async uploadDirect(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Body() body?: any,
  ) {
    // Check if request is multipart
    const isMultipart =
      typeof (req as any).isMultipart === 'function'
        ? (req as any).isMultipart()
        : false;
    if (!isMultipart) {
      // Allow JSON createFileRecord fallback
      if (body && (body.filename || body.name)) {
        const node = new StorageNode({
          id: crypto.randomUUID(),
          projectId: body.projectId || null,
          name: body.filename || body.name,
          isFolder: false,
          size: BigInt(body.size || 0),
          mimeType: body.mimeType || 'application/octet-stream',
          parentId: body.parentId || null,
          authorId: userId,
          metadata: {
            url: body.url,
            thumbnail: body.thumbnail,
            ...(body.metaData || {}),
          },
        });
        const created = await this.nodeRepo.create(node);
        return {
          id: created.id,
          fileId: created.id,
          filename: created.name,
          url:
            body.url || `/api/files/${encodeURIComponent(created.id)}/content`,
          file: {
            id: created.id,
            filename: created.name,
            size: Number(created.size),
            url:
              body.url ||
              `/api/files/${encodeURIComponent(created.id)}/content`,
          },
        };
      }
      throw new BadRequestException(
        'Request must be multipart/form-data or provide file metadata JSON',
      );
    }

    const data = await (req as any).file();
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }

    const buffer = await data.toBuffer();
    const fields = data.fields || {};
    const fieldFilename =
      fields.fileName?.value || fields.filename?.value || fields.name?.value;
    const filename =
      (data.filename && data.filename !== 'blob'
        ? data.filename
        : fieldFilename) ||
      data.filename ||
      'uploaded-file';
    const mimeType = data.mimetype || 'application/octet-stream';

    const projectId = fields.projectId?.value;
    const parentId = fields.parentId?.value;

    const result = await this.uploadDirectUseCase.execute({
      userId,
      filename,
      buffer,
      mimeType,
      projectId,
      parentId,
    });

    return {
      ...result,
      id: result.fileId,
      file: {
        id: result.fileId,
        filename: result.filename,
        size: result.size,
        mimeType: result.mimeType,
        url: result.url,
      },
    };
  }

  @Post('upload-r2')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Legacy / Editor upload endpoint' })
  async uploadR2(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.uploadDirect(userId, req);
  }

  @Post(['pages/:pageId/upload', 'page/:pageId/upload'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload file attached to a page (Editor compatibility)',
  })
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Body() body?: any,
  ) {
    const isMultipart =
      typeof (req as any).isMultipart === 'function'
        ? (req as any).isMultipart()
        : false;
    if (isMultipart) {
      const data = await (req as any).file();
      if (!data) {
        throw new BadRequestException('No file uploaded');
      }
      const buffer = await data.toBuffer();
      const fields = data.fields || {};
      const fieldFilename =
        fields.fileName?.value || fields.filename?.value || fields.name?.value;
      const filename =
        (data.filename && data.filename !== 'blob'
          ? data.filename
          : fieldFilename) ||
        data.filename ||
        'uploaded-file';
      const mimeType = data.mimetype || 'application/octet-stream';
      const parentId = fields.parentId?.value;

      const res = await this.uploadDirectUseCase.execute({
        userId,
        projectId: pageId,
        scope: FileScope.Page,
        filename,
        buffer,
        mimeType,
        parentId,
      });

      return {
        ...res,
        id: res.fileId,
        file: {
          id: res.fileId,
          filename: res.filename,
          size: res.size,
          mimeType: res.mimeType,
          url: res.url,
        },
      };
    }

    const filename = body?.filename || 'untitled-file';
    const mimeType = body?.mimeType || 'application/octet-stream';
    let buffer = Buffer.alloc(0);

    if (body?.fileBase64) {
      const base64Data = body.fileBase64.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(base64Data, 'base64');
    }

    const res = await this.uploadDirectUseCase.execute({
      userId,
      projectId: pageId,
      scope: FileScope.Page,
      filename,
      buffer,
      mimeType,
      parentId: body?.parentId,
    });

    return {
      ...res,
      id: res.fileId,
      file: {
        id: res.fileId,
        filename: res.filename,
        size: res.size,
        mimeType: res.mimeType,
        url: res.url,
      },
    };
  }

  // -------------------------
  // S3 Multipart Upload APIs (> 100MB)
  // -------------------------

  @Post('multipart/initiate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate a chunked multipart upload session' })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: InitiateMultipartDto,
  ) {
    const totalSize = dto.totalSize ?? dto.sizeBytes ?? dto.size;
    if (!totalSize || totalSize <= 0) {
      throw new BadRequestException(
        'Total file size is required and must be greater than 0',
      );
    }
    return this.multipartUploadUseCase.initiate({
      userId,
      filename: dto.filename,
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize,
      projectId: dto.projectId,
      parentId: dto.parentId,
    });
  }

  @Get('multipart/:sessionId/part-url')
  @ApiOperation({ summary: 'Get presigned part upload URL' })
  async getPartUrl(
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumber: number,
  ) {
    const url = await this.multipartUploadUseCase.getPartUrl(
      sessionId,
      Number(partNumber),
    );
    return { partNumber: Number(partNumber), uploadUrl: url };
  }

  @Post('multipart/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete multipart upload and assemble file' })
  async completeMultipart(@Body() dto: CompleteMultipartDto) {
    return this.multipartUploadUseCase.complete({
      sessionId: dto.sessionId,
      parts: dto.parts,
    });
  }

  @Delete('multipart/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort multipart upload session' })
  async abortMultipart(@Param('sessionId') sessionId: string) {
    await this.multipartUploadUseCase.abort(sessionId);
    return { success: true };
  }
}
