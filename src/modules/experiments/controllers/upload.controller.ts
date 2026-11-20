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
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import { cleanUuid, FilesBatchPartUrlsDto } from '@/modules/files';
import { getFileContentPath } from '../experiments.type';
import {
  ExperimentsAccessPolicy,
  normalizeExperimentProjectId,
} from '../domain/access.policy';
import { ExperimentsService } from '../services/experiments.service';
import { UploadService } from '../services/upload.service';
import {
  CompleteMultipartDto,
  CompletePresignedDto,
  InitiateMultipartDto,
  PresignDto,
} from '../dto/upload.dto';

interface UploadUser {
  id?: string;
  sub?: string;
  status?: string;
  isVerified?: boolean;
}

interface MultipartField {
  value?: string;
}

interface UploadRequest extends FastifyRequest {
  user?: UploadUser;
}

const UNVERIFIED_MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

@ApiTags('Experiments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/experiments/files')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly experimentsService: ExperimentsService,
    private readonly accessPolicy: ExperimentsAccessPolicy,
  ) {}

  private assertVerifiedUploadLimit(
    user: UploadUser | null | undefined,
    sizeBytes: number,
  ): void {
    const isUnverified =
      user?.status === 'pending_verification' || user?.isVerified === false;
    if (isUnverified && sizeBytes > UNVERIFIED_MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        'Unverified accounts are limited to uploading files up to 5MB. Please verify your email address.',
      );
    }
  }

  private formatUploadResponse<
    T extends {
      fileId: string;
      filename: string;
      size: number;
      mimeType?: string;
      url: string;
    },
  >(result: T) {
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

  private async extractMultipartPayload(uploadReq: UploadRequest): Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    fields: Record<string, MultipartField | undefined>;
  }> {
    const data = await uploadReq.file?.();
    if (!data) {
      throw new BadRequestException('No file uploaded');
    }

    const buffer = await data.toBuffer();
    const fields = (data.fields || {}) as Record<
      string,
      MultipartField | undefined
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

    return { buffer, filename, mimeType, fields };
  }

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate presigned URL for direct upload' })
  async presign(
    @CurrentUser() user: UploadUser | null,
    @Body() dto: PresignDto,
  ) {
    const userId = user?.id || user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }

    const requestedSize = dto.size ?? dto.sizeBytes ?? 10 * 1024 * 1024;
    this.assertVerifiedUploadLimit(user, requestedSize);

    const normalizedProjectId = normalizeExperimentProjectId(
      dto.spaceId,
      userId,
    );

    await this.accessPolicy.assertCanWriteScope(userId, {
      projectId: normalizedProjectId || null,
      parentId: dto.parentId || null,
    });

    return this.uploadService.presign({
      userId,
      filename: dto.filename,
      mimeType: dto.mimeType || dto.contentType || 'application/octet-stream',
      sizeBytes: requestedSize,
      projectId: normalizedProjectId,
      parentId: dto.parentId,
      contentHash: dto.contentHash,
      metaData: dto.metaData,
    });
  }

  @Post('presign/complete')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register and finalize a direct presigned upload' })
  async completePresigned(
    @CurrentUser() user: UploadUser | null,
    @Body() dto: CompletePresignedDto,
  ) {
    const userId = user?.id || user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }

    const reportedSize = dto.size ?? dto.sizeBytes ?? 0;
    this.assertVerifiedUploadLimit(user, reportedSize);

    const normalizedProjectId = normalizeExperimentProjectId(
      dto.spaceId,
      userId,
    );

    await this.accessPolicy.assertCanWriteScope(userId, {
      projectId: normalizedProjectId || null,
      parentId: dto.parentId || null,
    });

    const result = await this.uploadService.complete({
      userId,
      storageKey: dto.storageKey,
      filename: dto.filename,
      sizeBytes: dto.size ?? dto.sizeBytes,
      mimeType: dto.mimeType,
      projectId: normalizedProjectId,
      parentId: dto.parentId,
      contentHash: dto.contentHash,
      metaData: dto.metaData,
    });

    return this.formatUploadResponse(result);
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
    const isMultipart =
      typeof uploadReq.isMultipart === 'function'
        ? uploadReq.isMultipart()
        : false;

    if (!isMultipart) {
      if (body && (body.filename || body.name)) {
        const rawProjectId = normalizeExperimentProjectId(
          body.spaceId as string | undefined,
          userId,
        );
        const parentId = cleanUuid(body.parentId as string | undefined);
        if (userId) {
          await this.accessPolicy.assertCanWriteScope(userId, {
            projectId: rawProjectId ?? null,
            parentId,
          });
        }
        const projectId = cleanUuid(rawProjectId);
        const created = await this.experimentsService.createLogicalNode({
          userId,
          projectId,
          name: (body.filename as string) || (body.name as string),
          size: BigInt((body.size as number | string) || 0),
          mimeType: (body.mimeType as string) || 'application/octet-stream',
          parentId,
          metadata: {
            url: body.url,
            thumbnail: body.thumbnail,
            ...((body.metaData as Record<string, unknown>) || {}),
          },
        });
        const fileUrl = (body.url as string) || getFileContentPath(created.id);
        return {
          id: created.id,
          fileId: created.id,
          filename: created.name,
          url: fileUrl,
          file: {
            id: created.id,
            filename: created.name,
            size: Number(created.size),
            url: fileUrl,
          },
        };
      }
      throw new BadRequestException(
        'Request must be multipart/form-data or provide file metadata JSON',
      );
    }

    const { buffer, filename, mimeType, fields } =
      await this.extractMultipartPayload(uploadReq);
    this.assertVerifiedUploadLimit(uploadReq.user, buffer.length);

    const rawProjectId = normalizeExperimentProjectId(
      fields.spaceId?.value,
      userId,
    );
    const parentId = cleanUuid(fields.parentId?.value) ?? undefined;

    if (userId) {
      await this.accessPolicy.assertCanWriteScope(userId, {
        projectId: rawProjectId ?? null,
        parentId: parentId ?? null,
      });
    }
    const projectId = cleanUuid(rawProjectId) ?? undefined;

    const result = await this.uploadService.upload({
      userId,
      filename,
      buffer,
      mimeType,
      projectId,
      parentId,
    });

    return this.formatUploadResponse(result);
  }

  @Post('multipart/initiate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate a chunked multipart upload session' })
  async initiateMultipart(
    @CurrentUser() user: UploadUser | null,
    @Body() dto: InitiateMultipartDto,
  ) {
    const userId = user?.id || user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }
    const totalSize = dto.totalSize ?? dto.sizeBytes ?? dto.size;
    if (!totalSize || totalSize <= 0) {
      throw new BadRequestException(
        'Total file size is required and must be greater than 0',
      );
    }
    this.assertVerifiedUploadLimit(user, totalSize);
    const normalizedProjectId = normalizeExperimentProjectId(
      dto.spaceId,
      userId,
    );
    await this.accessPolicy.assertCanWriteScope(userId, {
      projectId: normalizedProjectId || null,
      parentId: dto.parentId || null,
    });
    return this.uploadService.initiateMultipart({
      userId,
      filename: dto.filename,
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize,
      projectId: normalizedProjectId,
      parentId: dto.parentId,
      expectedHash: dto.expectedHash,
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
    const url = await this.uploadService.getMultipartPartUrl(
      sessionId,
      parsedPartNumber,
      { userId },
    );
    return { partNumber: parsedPartNumber, uploadUrl: url };
  }

  @Post('multipart/:sessionId/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch generate presigned part upload URLs' })
  async getPartUrls(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: FilesBatchPartUrlsDto,
  ) {
    if (!userId) {
      throw new UnauthorizedException('User is not authenticated');
    }
    const parts = await this.uploadService.getMultipartPartUrls(
      sessionId,
      dto.partNumbers,
      { userId },
    );
    return { parts };
  }

  @Post('multipart/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete multipart upload and assemble file' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
  ) {
    return this.uploadService.completeMultipart({
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
    await this.uploadService.abortMultipart(sessionId, { userId });
    return { success: true };
  }
}
