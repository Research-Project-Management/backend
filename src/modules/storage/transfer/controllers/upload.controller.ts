import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import {
  DirectUploadService,
  PresignService,
  CompletePresignService,
} from '../services/upload.service';
import { MultipartService } from '../services/multipart.service';
import {
  PresignDto,
  CompletePresignedDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
} from '../dto/file.dto';
import { DriveService, FileScope } from '@/modules/storage/drive';

interface PageUploadBody {
  filename?: string;
  mimeType?: string;
  fileBase64?: string;
  parentId?: string;
}

interface UploadRequest extends FastifyRequest {
  user?: {
    id?: string;
    status?: string;
    isVerified?: boolean;
  };
}

@ApiTags('Storage & Uploads')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/storage/files')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: DirectUploadService,
    private readonly presignService: PresignService,
    private readonly completePresignService: CompletePresignService,
    private readonly multipartService: MultipartService,
    private readonly driveService: DriveService,
  ) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for direct upload' })
  async presign(
    @CurrentUser()
    user: {
      id?: string;
      sub?: string;
      status?: string;
      isVerified?: boolean;
    } | null,
    @Body() dto: PresignDto,
  ) {
    const userId = user?.id || user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }
    const isUnverified =
      user?.status === 'pending_verification' || user?.isVerified === false;
    const requestedSize = dto.size || 10 * 1024 * 1024;

    if (isUnverified && requestedSize > 5 * 1024 * 1024) {
      throw new BadRequestException(
        'Unverified accounts are limited to uploading files up to 5MB. Please verify your email address.',
      );
    }

    return this.presignService.presign({
      userId,
      filename: dto.filename,
      mimeType: dto.mimeType || dto.contentType || 'application/octet-stream',
      sizeBytes: requestedSize,
    });
  }

  @Post('presign/complete')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register and finalize a direct presigned upload' })
  async completePresigned(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignedDto,
  ) {
    const result = await this.completePresignService.complete({
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
    @Body() body?: Record<string, unknown>,
  ) {
    const uploadReq = req as unknown as UploadRequest;
    // Check if request is multipart
    const isMultipart =
      typeof uploadReq.isMultipart === 'function'
        ? uploadReq.isMultipart()
        : false;
    if (!isMultipart) {
      // Allow JSON createFileRecord fallback delegated to DriveService
      if (body && (body.filename || body.name)) {
        const created = await this.driveService.createLogicalNode({
          userId,
          projectId: (body.projectId as string) || null,
          name: (body.filename as string) || (body.name as string),
          size: BigInt((body.size as number | string) || 0),
          mimeType: (body.mimeType as string) || 'application/octet-stream',
          parentId: (body.parentId as string) || null,
          metadata: {
            url: body.url,
            thumbnail: body.thumbnail,
            ...((body.metaData as Record<string, unknown>) || {}),
          },
        });
        return {
          id: created.id,
          fileId: created.id,
          filename: created.name,
          url:
            (body.url as string) ||
            `/api/v1/storage/files/${encodeURIComponent(created.id)}/content`,
          file: {
            id: created.id,
            filename: created.name,
            size: Number(created.size),
            url:
              (body.url as string) ||
              `/api/v1/storage/files/${encodeURIComponent(created.id)}/content`,
          },
        };
      }
      throw new BadRequestException(
        'Request must be multipart/form-data or provide file metadata JSON',
      );
    }

    const data = await uploadReq.file?.();
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }

    const buffer = await data.toBuffer();
    const user = uploadReq.user;
    const isUnverified =
      user?.status === 'pending_verification' || user?.isVerified === false;

    if (isUnverified && buffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException(
        'Unverified accounts are limited to uploading files up to 5MB. Please verify your email address.',
      );
    }

    const fields = (data.fields || {}) as Record<
      string,
      { value?: string } | undefined
    >;
    const fieldFilename =
      fields.fileName?.value || fields.filename?.value || fields.name?.value;
    const filename =
      (data.filename && data.filename !== 'blob'
        ? data.filename
        : fieldFilename) ||
      data.filename ||
      'uploaded-file';
    const mimeType = data.mimetype || 'application/octet-stream';

    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const cleanUuid = (val: unknown): string | undefined => {
      if (typeof val !== 'string') return undefined;
      const trimmed = val.trim();
      return UUID_REGEX.test(trimmed) ? trimmed : undefined;
    };

    const projectId = cleanUuid(fields.projectId?.value);
    const parentId = cleanUuid(fields.parentId?.value);

    const result = await this.uploadService.upload({
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

  @Post('pages/:pageId/upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload file attached to a page (Editor compatibility)',
  })
  async uploadPageFile(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Body() body?: PageUploadBody,
  ) {
    const uploadReq = req as UploadRequest;
    const isMultipart =
      typeof uploadReq.isMultipart === 'function'
        ? uploadReq.isMultipart()
        : false;
    if (isMultipart) {
      const data = await uploadReq.file?.();
      if (!data) {
        throw new BadRequestException('No file uploaded');
      }
      const buffer = await data.toBuffer();
      const fields = (data.fields || {}) as Record<
        string,
        { value?: string } | undefined
      >;
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

      const res = await this.uploadService.upload({
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

    const res = await this.uploadService.upload({
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
    return this.multipartService.initiate({
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
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumber: number,
  ) {
    const parsedPartNumber = Number(partNumber);
    if (!Number.isInteger(parsedPartNumber) || parsedPartNumber < 1) {
      throw new BadRequestException('Invalid partNumber query parameter');
    }
    const url = await this.multipartService.getPartUrl(
      sessionId,
      parsedPartNumber,
      { userId },
    );
    return { partNumber: parsedPartNumber, uploadUrl: url };
  }

  @Post('multipart/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete multipart upload and assemble file' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
  ) {
    return this.multipartService.complete({
      sessionId: dto.sessionId,
      parts: dto.parts,
      actor: { userId },
    });
  }

  @Delete('multipart/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abort multipart upload session' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.multipartService.abort(sessionId, { userId });
    return { success: true };
  }
}
