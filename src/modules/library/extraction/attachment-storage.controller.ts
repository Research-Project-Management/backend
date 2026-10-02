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
  Optional,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { AttachmentsService } from './core/services/attachments.service';
import { GetAttachmentUseCase } from './core/use-cases/get-attachment.use-case';
import { toValidProjectId } from '../shared-kernel';
import {
  PresignUploadDto,
  CompletePresignDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
} from './dto/attachments.dto';

@ApiTags('Library Attachments - Storage Gateway')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AttachmentStorageController {
  constructor(
    @Optional()
    @Inject(STORAGE_PORT)
    protected readonly storagePort?: IStoragePort,
    @Optional()
    protected readonly getAttachmentUseCase?: GetAttachmentUseCase,
    @Optional()
    protected readonly attachmentsService?: AttachmentsService,
  ) {}

  @Post(['attachments/upload', 'upload', 'files/upload'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Upload a binary file directly via multipart stream',
  })
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.uploadFile) {
      throw new BadRequestException('Storage service is unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

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
        'No file payload received in multipart request',
      );
    }

    const uploaded = await this.storagePort.uploadFile({
      userId,
      projectId: effectiveProjectId,
      filename,
      mimeType,
      buffer,
      source: 'library',
    });

    const fileId = (uploaded as any).fileId || (uploaded as any).id;
    return {
      success: true,
      fileId,
      url: uploaded.url,
      filename: uploaded.filename,
      size: uploaded.size,
      mimeType: uploaded.mimeType,
      storageKey: (uploaded as any).storageKey,
      fileUuid: fileId,
      id: fileId,
    };
  }

  @Post(['attachments/presign', 'presign'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Get direct S3/R2 presigned upload URL' })
  async presign(
    @CurrentUser('id') userId: string,
    @Body() dto: PresignUploadDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.getPresignedUploadUrl) {
      throw new BadRequestException('Presigned upload unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    return this.storagePort.getPresignedUploadUrl({
      userId,
      filename: dto.filename || 'document.pdf',
      mimeType: dto.mimeType || 'application/pdf',
      sizeBytes: dto.sizeBytes || 0,
      contentHash: dto.contentHash,
      projectId: effectiveProjectId,
      scope: 'library',
    });
  }

  @Post(['attachments/presign/complete', 'presign/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Complete presigned upload' })
  async completePresign(
    @CurrentUser('id') userId: string,
    @Body() dto: CompletePresignDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.completePresignedUpload) {
      throw new BadRequestException('Presigned upload completion unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    const completed = await this.storagePort.completePresignedUpload({
      userId,
      projectId: effectiveProjectId,
      storageKey: dto.storageKey,
      filename: dto.filename,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      contentHash: dto.contentHash,
      scope: 'library',
    });

    return {
      success: true,
      fileId: completed.fileId,
      url: completed.url,
      filename: completed.filename,
      size: completed.size,
      mimeType: completed.mimeType,
    };
  }

  @Post(['attachments/multipart/initiate', 'multipart/initiate'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Initiate multipart upload session' })
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: InitiateMultipartDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.initiateMultipartUpload) {
      throw new BadRequestException('Multipart upload unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    return this.storagePort.initiateMultipartUpload({
      userId,
      filename: dto.filename || 'document.bin',
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize: dto.totalSize,
      projectId: effectiveProjectId,
      scope: 'library',
      expectedHash: dto.expectedHash,
    });
  }

  @Get([
    'attachments/multipart/:sessionId/part-url',
    'multipart/:sessionId/part-url',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Get multipart upload part URL' })
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumberStr: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.getMultipartPartUrl) {
      throw new BadRequestException('Multipart part URL unavailable');
    }

    const partNumber = parseInt(partNumberStr, 10);
    if (isNaN(partNumber) || partNumber < 1) {
      throw new BadRequestException('Invalid partNumber query parameter');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    const partUrl = await this.storagePort.getMultipartPartUrl(
      sessionId,
      partNumber,
      { userId, projectId: effectiveProjectId },
    );
    return { partNumber, partUrl };
  }

  @Post(['attachments/multipart/complete', 'multipart/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Complete multipart upload' })
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMultipartDto,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.storagePort?.completeMultipartUpload) {
      throw new BadRequestException('Multipart completion unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    return this.storagePort.completeMultipartUpload({
      sessionId: dto.sessionId,
      parts: dto.parts,
      actor: { userId, projectId: effectiveProjectId },
    });
  }

  @Delete([
    'attachments/multipart/:sessionId/abort',
    'multipart/:sessionId/abort',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Abort multipart upload session' })
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (this.storagePort?.abortMultipartUpload) {
      const effectiveProjectId = toValidProjectId(
        paramProjectId || queryProjectId,
      );
      await this.storagePort.abortMultipartUpload(sessionId, {
        userId,
        projectId: effectiveProjectId,
      });
    }
    return { success: true };
  }

  @Get(['attachments/files/:fileId/content', 'files/:fileId/content'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Stream library file by storage file ID' })
  async streamLibraryFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!this.storagePort) {
      throw new NotFoundException('Storage port unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    if (this.storagePort.getOwnedFileStream) {
      const fileRecord = await this.storagePort.getOwnedFileStream({
        fileId,
        userId,
        projectId: effectiveProjectId,
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
        projectId: effectiveProjectId,
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

  @Get('attachments/:attachmentId/presigned-url')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get presigned download URL for an attachment' })
  async getAttachmentPresignedUrl(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    let result: any;
    if (this.getAttachmentUseCase?.execute) {
      result = await this.getAttachmentUseCase.execute(
        userId,
        undefined,
        attachmentId,
        effectiveProjectId,
      );
    } else if (this.attachmentsService) {
      result = await this.attachmentsService.getItemAttachment(
        userId,
        undefined,
        attachmentId,
        effectiveProjectId,
      );
    }

    const attachment = result?.attachment || result;
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

  @Get('attachments/:attachmentId/content')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Stream attachment content with range support' })
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    let result: any;
    if (this.getAttachmentUseCase?.execute) {
      result = await this.getAttachmentUseCase.execute(
        userId,
        undefined,
        attachmentId,
        effectiveProjectId,
      );
    } else if (this.attachmentsService) {
      result = await this.attachmentsService.getItemAttachment(
        userId,
        undefined,
        attachmentId,
        effectiveProjectId,
      );
    }

    const attachment = result?.attachment || result;

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
          projectId: effectiveProjectId,
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
          projectId: effectiveProjectId,
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
