import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Inject,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { AttachmentsService } from '../services/attachments.service';
import {
  PresignUploadDto,
  CompletePresignDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
} from '../dto/attachments.dto';

/**
 * Shared Base Adapter for Library Attachment Binary Storage Operations.
 */
export abstract class BaseAttachmentStorageController {
  constructor(
    @Inject(STORAGE_PORT)
    protected readonly storagePort: IStoragePort,
    protected readonly attachmentsService: AttachmentsService,
  ) {}

  protected async executeUploadLibraryFile(
    userId: string,
    req: FastifyRequest,
    projectId?: string,
  ) {
    if (!this.storagePort?.uploadFile) {
      throw new BadRequestException('Storage service is unavailable');
    }

    let buffer: Buffer | undefined;
    let filename = 'document.pdf';
    let mimeType = 'application/pdf';

    const parts = (req as any).parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        filename = part.filename || filename;
        mimeType = part.mimetype || mimeType;
      }
    }

    if (!buffer) {
      throw new BadRequestException(
        'No binary file provided in multipart body',
      );
    }

    const uploadResult = await this.storagePort.uploadFile({
      userId,
      projectId,
      filename,
      mimeType,
      buffer,
      source: 'library',
    });

    return {
      success: true,
      ...uploadResult,
    };
  }

  getPresignedUploadUrl(
    userId: string,
    dto: PresignUploadDto,
    projectId?: string,
  ) {
    return this.executePresignUpload(userId, dto, projectId);
  }

  protected async executePresignUpload(
    userId: string,
    dto: PresignUploadDto,
    projectId?: string,
  ) {
    if (!this.storagePort?.getPresignedUploadUrl) {
      throw new BadRequestException('Direct presigned upload unavailable');
    }

    return this.storagePort.getPresignedUploadUrl({
      userId,
      projectId,
      filename: dto.filename,
      mimeType: dto.mimeType || 'application/octet-stream',
      sizeBytes: dto.sizeBytes || 0,
      scope: 'library',
      contentHash: dto.contentHash,
    });
  }

  protected async executeCompletePresignedUpload(
    userId: string,
    dto: CompletePresignDto,
    projectId?: string,
  ) {
    if (!this.storagePort?.completePresignedUpload) {
      return { success: true, storageKey: dto.storageKey };
    }

    return this.storagePort.completePresignedUpload({
      storageKey: dto.storageKey,
      filename: dto.filename,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      contentHash: dto.contentHash,
      userId,
      projectId,
    });
  }

  protected async executeInitiateMultipart(
    userId: string,
    dto: InitiateMultipartDto,
    projectId?: string,
  ) {
    if (!this.storagePort?.initiateMultipartUpload) {
      throw new BadRequestException('Multipart upload unavailable');
    }

    return this.storagePort.initiateMultipartUpload({
      userId,
      filename: dto.filename || 'document.bin',
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize: dto.totalSize,
      projectId,
      scope: 'library',
      expectedHash: dto.expectedHash,
    });
  }

  protected async executeGetMultipartPartUrl(
    userId: string,
    sessionId: string,
    partNumberStr: string,
    projectId?: string,
  ) {
    if (!this.storagePort?.getMultipartPartUrl) {
      throw new BadRequestException('Multipart part URL unavailable');
    }

    const partNumber = parseInt(partNumberStr, 10);
    if (isNaN(partNumber) || partNumber < 1) {
      throw new BadRequestException('Invalid partNumber query parameter');
    }

    const partUrl = await this.storagePort.getMultipartPartUrl(
      sessionId,
      partNumber,
      { userId, projectId },
    );
    return { partNumber, partUrl };
  }

  protected async executeCompleteMultipart(
    userId: string,
    dto: CompleteMultipartDto,
    projectId?: string,
  ) {
    if (!this.storagePort?.completeMultipartUpload) {
      throw new BadRequestException('Multipart completion unavailable');
    }

    return this.storagePort.completeMultipartUpload({
      sessionId: dto.sessionId,
      parts: dto.parts,
      actor: { userId, projectId },
    });
  }

  protected async executeAbortMultipart(
    userId: string,
    sessionId: string,
    projectId?: string,
  ) {
    if (this.storagePort?.abortMultipartUpload) {
      await this.storagePort.abortMultipartUpload(sessionId, {
        userId,
        projectId,
      });
    }
    return { success: true };
  }

  protected async executeStreamLibraryFile(
    fileId: string,
    userId: string,
    res: FastifyReply,
    projectId?: string,
  ) {
    if (!this.storagePort) {
      throw new NotFoundException('Storage port unavailable');
    }

    if (this.storagePort.getOwnedFileStream) {
      const fileRecord = await this.storagePort.getOwnedFileStream({
        fileId,
        userId,
        projectId,
      });

      return this.sendAttachmentPayload(res, {
        content: fileRecord.stream,
        filename: fileRecord.filename,
        size: fileRecord.size,
        mimeType: fileRecord.mimeType,
      });
    }

    if (this.storagePort.readOwnedFile) {
      const fileRecord = await this.storagePort.readOwnedFile({
        fileId,
        userId,
        projectId,
      });

      return this.sendAttachmentPayload(res, {
        content: fileRecord.buffer,
        filename: fileRecord.filename,
        size: fileRecord.size,
        mimeType: fileRecord.mimeType,
      });
    }

    throw new NotFoundException('Storage port read capability unavailable');
  }

  protected async executeGetAttachmentPresignedUrl(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ) {
    const result = await this.attachmentsService.getItemAttachment(
      userId,
      undefined,
      attachmentId,
      projectId,
    );

    const attachment = (result as any)?.attachment || result;
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort?.getPresignedDownloadUrl) {
      const presignedUrl = await this.storagePort.getPresignedDownloadUrl(
        attachment.fileId,
        3600,
      );
      return {
        url: presignedUrl,
        expiresIn: 3600,
        filename: attachment.filename || 'attachment.pdf',
        mimeType: attachment.mimeType || 'application/pdf',
      };
    }

    if (attachment.url) {
      return {
        url: attachment.url,
        expiresIn: 3600,
        filename: attachment.filename || 'attachment.pdf',
        mimeType: attachment.mimeType || 'application/pdf',
      };
    }

    throw new BadRequestException(
      'Presigned download URL unavailable for this attachment',
    );
  }

  protected async executeStreamAttachmentContent(
    userId: string,
    attachmentId: string,
    req: FastifyRequest,
    res: FastifyReply,
    projectId?: string,
  ) {
    const result = await this.attachmentsService.getItemAttachment(
      userId,
      undefined,
      attachmentId,
      projectId,
    );

    const attachment = (result as any)?.attachment || result;

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort) {
      const defaultFilename = attachment.filename || 'attachment.pdf';
      const defaultMimeType = attachment.mimeType;

      const rangeHeader = (req as any)?.headers?.range;
      let range: { start: number; end: number } | undefined;
      if (
        rangeHeader &&
        typeof rangeHeader === 'string' &&
        /^bytes=\d+-\d*$/.test(rangeHeader)
      ) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : undefined;
        if (!isNaN(start)) {
          range = { start, end: end ?? -1 };
        }
      }

      if (this.storagePort.getOwnedFileStream) {
        const fileRecord = await this.storagePort.getOwnedFileStream({
          fileId: attachment.fileId,
          userId,
          projectId,
          ...(range ? { range } : {}),
        });

        return this.sendAttachmentPayload(res, {
          content: fileRecord.stream,
          filename:
            attachment.filename || fileRecord.filename || defaultFilename,
          size: fileRecord.size,
          mimeType: fileRecord.mimeType || defaultMimeType,
          contentRange: fileRecord.contentRange,
        });
      }

      if (this.storagePort.readOwnedFile) {
        const fileRecord = await this.storagePort.readOwnedFile({
          fileId: attachment.fileId,
          userId,
          projectId,
        });

        return this.sendAttachmentPayload(res, {
          content: fileRecord.buffer,
          filename:
            attachment.filename || fileRecord.filename || defaultFilename,
          size: fileRecord.size,
          mimeType: fileRecord.mimeType || defaultMimeType,
        });
      }
    }

    if (attachment.url) {
      return res.redirect(attachment.url, 302);
    }

    throw new NotFoundException(
      'No content stream available for this attachment',
    );
  }

  protected sendAttachmentPayload(
    res: FastifyReply,
    payload: {
      content: any;
      filename: string;
      size: number;
      mimeType?: string;
      contentRange?: string;
    },
  ) {
    res.header('Content-Type', payload.mimeType || 'application/pdf');
    res.header(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(payload.filename)}"`,
    );
    res.header('Accept-Ranges', 'bytes');
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Vary', 'Authorization, Range');

    if (payload.contentRange) {
      res.status(206);
      res.header('Content-Range', payload.contentRange);
    }

    res.header('Content-Length', payload.size);
    return res.send(payload.content);
  }
}

/**
 * User Library Storage Controller (/api/v1/library).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Attachments - User Storage Gateway')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library')
@UseGuards(JwtAuthGuard)
export class AttachmentStorageController extends BaseAttachmentStorageController {
  constructor(
    @Inject(STORAGE_PORT)
    storagePort: IStoragePort,
    attachmentsService: AttachmentsService,
  ) {
    super(storagePort, attachmentsService);
  }

  @Post(['attachments/upload', 'upload', 'files/upload'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Upload a binary file directly via multipart stream to user library',
  })
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeUploadLibraryFile(
      userId,
      req,
      paramProjectId || queryProjectId,
    );
  }

  @Post(['attachments/presign-upload', 'files/presign-upload'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Obtain presigned upload URL for direct S3 upload' })
  async presignUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: PresignUploadDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executePresignUpload(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post(['attachments/complete-upload', 'files/complete-upload'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete and verify presigned S3 upload' })
  async completePresignedUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeCompletePresignedUpload(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post(['attachments/multipart/initiate', 'files/multipart/initiate'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate S3 multipart upload session' })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: InitiateMultipartDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeInitiateMultipart(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Get([
    'attachments/multipart/:sessionId/part-url',
    'files/multipart/:sessionId/part-url',
  ])
  @ApiOperation({
    summary: 'Get presigned URL for specific S3 multipart chunk',
  })
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumber: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeGetMultipartPartUrl(
      userId,
      sessionId,
      partNumber,
      paramProjectId || queryProjectId,
    );
  }

  @Post(['attachments/multipart/complete', 'files/multipart/complete'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete S3 multipart upload session' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeCompleteMultipart(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Delete(['attachments/multipart/:sessionId', 'files/multipart/:sessionId'])
  @ApiOperation({ summary: 'Abort S3 multipart upload session' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeAbortMultipart(
      userId,
      sessionId,
      paramProjectId || queryProjectId,
    );
  }

  @Get(['files/:fileId', 'files/:fileId/content'])
  @ApiOperation({ summary: 'Stream binary content directly by fileId' })
  async streamLibraryFile(
    @CurrentUser('id') userId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeStreamLibraryFile(
      fileId,
      userId,
      res,
      paramProjectId || queryProjectId,
    );
  }

  @Get('attachments/:attachmentId/presigned-url')
  @ApiOperation({
    summary: 'Get direct S3 presigned URL for downloading user attachment',
  })
  async getAttachmentPresignedUrl(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeGetAttachmentPresignedUrl(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Get([
    'attachments/:attachmentId/content',
    'items/:itemId/attachments/:attachmentId/content',
    'attachments/:attachmentId/pdf',
    'items/:itemId/attachments/:attachmentId/pdf',
  ])
  @ApiOperation({
    summary: 'Stream user attachment binary content with byte-range support',
  })
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeStreamAttachmentContent(
      userId,
      attachmentId,
      req,
      res,
      paramProjectId || queryProjectId,
    );
  }
}

/**
 * Project Library Storage Controller (/api/v1/projects/:projectId/library).
 * Validates project UUID & enforces project roles.
 */
@ApiTags('Library Attachments - Project Storage Gateway')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectAttachmentStorageController extends BaseAttachmentStorageController {
  constructor(
    @Inject(STORAGE_PORT)
    storagePort: IStoragePort,
    attachmentsService: AttachmentsService,
  ) {
    super(storagePort, attachmentsService);
  }

  @Post(['attachments/upload', 'upload', 'files/upload'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Upload binary file directly via multipart stream to project library',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeUploadLibraryFile(userId, req, projectId);
  }

  @Post(['attachments/presign-upload', 'files/presign-upload'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Obtain presigned upload URL for direct S3 upload' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async presignUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: PresignUploadDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executePresignUpload(userId, dto, projectId);
  }

  @Post(['attachments/complete-upload', 'files/complete-upload'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete and verify presigned S3 upload' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async completePresignedUpload(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeCompletePresignedUpload(userId, dto, projectId);
  }

  @Post(['attachments/multipart/initiate', 'files/multipart/initiate'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate S3 multipart upload session' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: InitiateMultipartDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeInitiateMultipart(userId, dto, projectId);
  }

  @Get([
    'attachments/multipart/:sessionId/part-url',
    'files/multipart/:sessionId/part-url',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get presigned URL for specific S3 multipart chunk',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumber: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetMultipartPartUrl(
      userId,
      sessionId,
      partNumber,
      projectId,
    );
  }

  @Post(['attachments/multipart/complete', 'files/multipart/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete S3 multipart upload session' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeCompleteMultipart(userId, dto, projectId);
  }

  @Delete(['attachments/multipart/:sessionId', 'files/multipart/:sessionId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Abort S3 multipart upload session' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeAbortMultipart(userId, sessionId, projectId);
  }

  @Get(['files/:fileId', 'files/:fileId/content'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Stream binary content directly by fileId' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async streamLibraryFile(
    @CurrentUser('id') userId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeStreamLibraryFile(fileId, userId, res, projectId);
  }

  @Get('attachments/:attachmentId/presigned-url')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get direct S3 presigned URL for downloading project attachment',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getAttachmentPresignedUrl(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetAttachmentPresignedUrl(
      userId,
      attachmentId,
      projectId,
    );
  }

  @Get([
    'attachments/:attachmentId/content',
    'items/:itemId/attachments/:attachmentId/content',
    'attachments/:attachmentId/pdf',
    'items/:itemId/attachments/:attachmentId/pdf',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Stream project attachment binary content with byte-range support',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeStreamAttachmentContent(
      userId,
      attachmentId,
      req,
      res,
      projectId,
    );
  }
}
