import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
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
import { AttachmentsService } from './core/use-cases/attachments.service';
import { WebSnapshotService } from './core/adapters/web-snapshot.service';
import {
  CreateAttachmentDto,
  ReplaceAttachmentFileDto,
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from './dto/attachments.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { isUUID } from 'class-validator';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

// CQRS Use Cases
import { CreateAttachmentUseCase } from './core/use-cases/create-attachment.use-case';
import { DeleteAttachmentUseCase } from './core/use-cases/delete-attachment.use-case';
import { SetPrimaryAttachmentUseCase } from './core/use-cases/set-primary-attachment.use-case';
import { RenameAttachmentUseCase } from './core/use-cases/rename-attachment.use-case';
import { BatchRenameAttachmentsUseCase } from './core/use-cases/batch-rename-attachments.use-case';
import { GetAttachmentUseCase } from './core/use-cases/get-attachment.use-case';
import { GetItemAttachmentsUseCase } from './core/use-cases/get-item-attachments.use-case';
import { GetAttachmentThumbnailUseCase } from './core/use-cases/get-attachment-thumbnail.use-case';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AttachmentController {
  private attachmentsServiceInstance?: AttachmentsService;
  private webSnapshotServiceInstance?: WebSnapshotService;
  private storagePortInstance?: IStoragePort;

  constructor(
    attachmentsService: AttachmentsService,
    webSnapshotService: WebSnapshotService,
    storagePort?: IStoragePort,
  );
  constructor(
    createAttachmentUseCase: CreateAttachmentUseCase,
    getAttachmentUseCase: GetAttachmentUseCase,
    getItemAttachmentsUseCase: GetItemAttachmentsUseCase,
    deleteAttachmentUseCase: DeleteAttachmentUseCase,
    setPrimaryAttachmentUseCase: SetPrimaryAttachmentUseCase,
    renameAttachmentUseCase: RenameAttachmentUseCase,
    batchRenameAttachmentsUseCase: BatchRenameAttachmentsUseCase,
    getThumbnailUseCase: GetAttachmentThumbnailUseCase,
    webSnapshotService: WebSnapshotService,
    storagePort?: IStoragePort,
    attachmentsService?: AttachmentsService,
  );
  constructor(
    @Optional() private readonly createAttachmentUseCase?: any,
    @Optional() private readonly getAttachmentUseCase?: any,
    @Optional() private readonly getItemAttachmentsUseCase?: any,
    @Optional()
    private readonly deleteAttachmentUseCase?: DeleteAttachmentUseCase,
    @Optional()
    private readonly setPrimaryAttachmentUseCase?: SetPrimaryAttachmentUseCase,
    @Optional()
    private readonly renameAttachmentUseCase?: RenameAttachmentUseCase,
    @Optional()
    private readonly batchRenameAttachmentsUseCase?: BatchRenameAttachmentsUseCase,
    @Optional()
    private readonly getThumbnailUseCase?: GetAttachmentThumbnailUseCase,
    @Optional() private readonly webSnapshotService?: WebSnapshotService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    private readonly attachmentsService?: AttachmentsService,
  ) {
    const isLegacyService =
      createAttachmentUseCase instanceof AttachmentsService ||
      (createAttachmentUseCase && !('execute' in createAttachmentUseCase));

    if (isLegacyService) {
      this.attachmentsServiceInstance =
        createAttachmentUseCase as AttachmentsService;
      this.webSnapshotServiceInstance =
        getAttachmentUseCase as WebSnapshotService;
      this.storagePortInstance = getItemAttachmentsUseCase as IStoragePort;
    } else {
      this.attachmentsServiceInstance = attachmentsService;
      this.webSnapshotServiceInstance = webSnapshotService;
      this.storagePortInstance = storagePort;
    }
  }

  private get effectiveStoragePort(): IStoragePort | undefined {
    return this.storagePortInstance ?? this.storagePort;
  }

  private get effectiveWebSnapshotService(): WebSnapshotService | undefined {
    return this.webSnapshotServiceInstance ?? this.webSnapshotService;
  }

  private get effectiveAttachmentsService(): AttachmentsService | undefined {
    return this.attachmentsServiceInstance ?? this.attachmentsService;
  }

  /**
   * Library Bounded Context Upload Gateway.
   * Frontend library uploads files through this gateway without directly referencing StorageModule.
   */
  @Post(['attachments/upload', 'upload', 'files/upload'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  async uploadLibraryFile(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.effectiveStoragePort?.uploadFile) {
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

    const uploaded = await this.effectiveStoragePort.uploadFile({
      userId,
      projectId: effectiveProjectId,
      filename,
      buffer,
      mimeType,
      source: 'library',
    });

    return {
      success: true,
      fileId: uploaded.fileId,
      url: uploaded.url,
      filename: uploaded.filename,
      size: uploaded.size,
      mimeType: uploaded.mimeType,
      data: uploaded,
    };
  }

  /**
   * Generates a presigned upload URL for direct S3/R2 ingestion,
   * or returns instant CAS deduplication if contentHash already exists.
   */
  @Post(['attachments/presign', 'presign'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async presign(
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      filename: string;
      mimeType?: string;
      sizeBytes?: number;
      contentHash?: string;
    },
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.effectiveStoragePort?.getPresignedUploadUrl) {
      throw new BadRequestException('Presigned upload unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    return this.effectiveStoragePort.getPresignedUploadUrl({
      userId,
      filename: dto.filename || 'document.pdf',
      mimeType: dto.mimeType || 'application/pdf',
      sizeBytes: dto.sizeBytes || 0,
      contentHash: dto.contentHash,
      projectId: effectiveProjectId,
      scope: 'library',
    });
  }

  /**
   * Completes a direct-to-storage presigned upload and creates a storage node.
   */
  @Post(['attachments/presign/complete', 'presign/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async completePresign(
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      storageKey: string;
      filename: string;
      mimeType?: string;
      sizeBytes?: number;
      contentHash?: string;
    },
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.effectiveStoragePort?.completePresignedUpload) {
      throw new BadRequestException('Presigned upload completion unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    const completed = await this.effectiveStoragePort.completePresignedUpload({
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

  /**
   * Phase 1: Initiate S3/R2 Multipart Upload session for large files (>50MB).
   */
  @Post(['attachments/multipart/initiate', 'multipart/initiate'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async initiateMultipart(
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      filename: string;
      mimeType?: string;
      totalSize: number;
      expectedHash?: string;
    },
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.effectiveStoragePort?.initiateMultipartUpload) {
      throw new BadRequestException('Multipart upload unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    return this.effectiveStoragePort.initiateMultipartUpload({
      userId,
      filename: dto.filename || 'document.bin',
      mimeType: dto.mimeType || 'application/octet-stream',
      totalSize: dto.totalSize,
      projectId: effectiveProjectId,
      scope: 'library',
      expectedHash: dto.expectedHash,
    });
  }

  /**
   * Phase 2: Get presigned PUT URL for an individual part.
   */
  @Get([
    'attachments/multipart/:sessionId/part-url',
    'multipart/:sessionId/part-url',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async getMultipartPartUrl(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumberStr: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.effectiveStoragePort?.getMultipartPartUrl) {
      throw new BadRequestException('Multipart part URL unavailable');
    }

    const partNumber = parseInt(partNumberStr, 10);
    if (isNaN(partNumber) || partNumber < 1) {
      throw new BadRequestException('Invalid partNumber query parameter');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    const partUrl = await this.effectiveStoragePort.getMultipartPartUrl(
      sessionId,
      partNumber,
      { userId, projectId: effectiveProjectId },
    );
    return { partNumber, partUrl };
  }

  /**
   * Phase 3: Complete multipart upload and assemble object in S3/R2.
   */
  @Post(['attachments/multipart/complete', 'multipart/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async completeMultipart(
    @CurrentUser('id') userId: string,
    @Body()
    dto: {
      sessionId: string;
      parts: { partNumber: number; eTag: string }[];
    },
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (!this.effectiveStoragePort?.completeMultipartUpload) {
      throw new BadRequestException('Multipart completion unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    return this.effectiveStoragePort.completeMultipartUpload({
      sessionId: dto.sessionId,
      parts: dto.parts,
      actor: { userId, projectId: effectiveProjectId },
    });
  }

  /**
   * Abort multipart upload session and clean up remote parts.
   */
  @Delete([
    'attachments/multipart/:sessionId/abort',
    'multipart/:sessionId/abort',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async abortMultipart(
    @CurrentUser('id') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    if (this.effectiveStoragePort?.abortMultipartUpload) {
      const effectiveProjectId = toValidProjectId(
        paramProjectId || queryProjectId,
      );
      await this.effectiveStoragePort.abortMultipartUpload(sessionId, {
        userId,
        projectId: effectiveProjectId,
      });
    }
    return { success: true };
  }

  /**
   * Stream / serve library file content scoped by access.
   */
  @Get(['attachments/files/:fileId/content', 'files/:fileId/content'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async streamLibraryFile(
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!this.effectiveStoragePort) {
      throw new NotFoundException('Storage port unavailable');
    }

    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    if (this.effectiveStoragePort.getOwnedFileStream) {
      const fileRecord = await this.effectiveStoragePort.getOwnedFileStream({
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

    if (this.effectiveStoragePort.readOwnedFile) {
      const fileRecord = await this.effectiveStoragePort.readOwnedFile({
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

  /**
   * Stream / serve attachment content by attachment ID.
   */
  /**
   * Generates a direct Presigned GET URL for zero-copy streaming via S3 / CDN.
   * Allows PDF.js and browsers to download/stream chunks directly from Object Storage.
   */
  @Get('attachments/:attachmentId/presigned-url')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
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
    } else if (this.effectiveAttachmentsService) {
      result = await this.effectiveAttachmentsService.getItemAttachment(
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

    if (
      attachment.fileId &&
      this.effectiveStoragePort?.getPresignedDownloadUrl
    ) {
      const presignedUrl =
        await this.effectiveStoragePort.getPresignedDownloadUrl(
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

  /**
   * Stream / serve attachment content by attachment ID with HTTP 206 Byte-Range support.
   */
  @Get('attachments/:attachmentId/content')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
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
    } else if (this.effectiveAttachmentsService) {
      result = await this.effectiveAttachmentsService.getItemAttachment(
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

    if (attachment.fileId && this.effectiveStoragePort) {
      const defaultFilename = attachment.filename || 'attachment.pdf';
      const defaultMimeType = attachment.mimeType;

      // Parse HTTP Range header if present (e.g. bytes=0-1048576)
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

      if (this.effectiveStoragePort.getOwnedFileStream) {
        const fileRecord = await this.effectiveStoragePort.getOwnedFileStream({
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

      if (this.effectiveStoragePort.readOwnedFile) {
        const fileRecord = await this.effectiveStoragePort.readOwnedFile({
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

  /**
   * Stream / serve attachment thumbnail by attachment ID.
   * Cached in browser privately for 24h with Vary: Authorization.
   */
  @Get([
    'attachments/:attachmentId/thumbnail',
    'items/:itemId/attachments/:attachmentId/thumbnail',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getAttachmentThumbnail(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;

    let thumbnail: { buffer: Buffer; mimeType: string };
    if (this.effectiveAttachmentsService?.getThumbnail) {
      thumbnail = await this.effectiveAttachmentsService.getThumbnail(
        userId,
        attachmentId,
        effectiveProjectId,
      );
    } else if (this.getThumbnailUseCase?.execute) {
      thumbnail = await this.getThumbnailUseCase.execute({
        userId,
        attachmentId,
        projectId: effectiveProjectId,
      });
    } else {
      throw new BadRequestException('Thumbnail service unavailable');
    }

    res.header('Content-Type', thumbnail.mimeType || 'image/webp');
    res.header('Cache-Control', 'private, max-age=86400');
    res.header('Vary', 'Authorization');
    res.header('Content-Length', thumbnail.buffer.length);
    return res.send(thumbnail.buffer);
  }

  @Get('items/:itemId/attachments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.getItemAttachmentsUseCase?.execute) {
      return this.getItemAttachmentsUseCase.execute({
        userId,
        itemId,
        projectId: effectiveProjectId,
      });
    }
    return this.effectiveAttachmentsService!.getItemAttachments(
      userId,
      itemId,
      effectiveProjectId,
    );
  }

  @Get(['attachments/:attachmentId', 'items/:itemId/attachments/:attachmentId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getItemAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.getAttachmentUseCase?.execute) {
      return this.getAttachmentUseCase.execute(
        userId,
        itemId,
        attachmentId,
        effectiveProjectId,
      );
    }
    return this.effectiveAttachmentsService!.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Post('items/:itemId/attachments')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  async createAttachment(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CreateAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.createAttachmentUseCase?.execute) {
      return this.createAttachmentUseCase.execute(
        {
          ...dto,
          userId,
          itemId,
        },
        effectiveProjectId,
      );
    }
    return this.effectiveAttachmentsService!.createAttachment(
      {
        ...dto,
        userId,
        itemId,
      },
      effectiveProjectId,
    );
  }

  @Post('attachments/:attachmentId/re-extract')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  async reExtractAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.effectiveAttachmentsService!.reExtractAttachment(
      userId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Delete('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.deleteAttachmentUseCase?.execute) {
      return this.deleteAttachmentUseCase.execute({
        userId,
        attachmentId,
        projectId: effectiveProjectId,
      });
    }
    return this.effectiveAttachmentsService!.deleteAttachment(
      userId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Post([
    'attachments/:attachmentId/set-primary',
    'items/:itemId/attachments/:attachmentId/set-primary',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const resolvedItemId =
      itemId || (await this.resolveAttachmentItemId(attachmentId));
    if (this.setPrimaryAttachmentUseCase?.execute) {
      return this.setPrimaryAttachmentUseCase.execute({
        userId,
        itemId: resolvedItemId,
        attachmentId,
        projectId: effectiveProjectId,
      });
    }
    return this.effectiveAttachmentsService!.setPrimaryAttachment(
      userId,
      resolvedItemId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Post('items/:itemId/attachments/snapshot')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  async captureSnapshot(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() body?: { url?: string; title?: string },
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    let targetUrl = body?.url?.trim();
    if (!targetUrl) {
      targetUrl = await this.effectiveAttachmentsService!.resolveItemUrl(
        itemId,
        userId,
        effectiveProjectId,
      );
    }

    return this.effectiveWebSnapshotService!.captureAndAttach(
      targetUrl,
      itemId,
      userId,
      {
        title: body?.title,
      },
    );
  }

  @Patch([
    'attachments/:attachmentId/rename',
    'items/:itemId/attachments/:attachmentId/rename',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async renameAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: RenameAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.renameAttachmentUseCase?.execute) {
      return this.renameAttachmentUseCase.execute({
        userId,
        attachmentId,
        dto,
        projectId: effectiveProjectId,
      });
    }
    return this.effectiveAttachmentsService!.renameAttachment(
      userId,
      attachmentId,
      dto,
      effectiveProjectId,
    );
  }

  @Post(['attachments/batch-rename', 'batch-rename-attachments'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  async batchRenameAttachments(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchRenameAttachmentsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.batchRenameAttachmentsUseCase?.execute) {
      return this.batchRenameAttachmentsUseCase.execute({
        userId,
        dto,
        projectId: effectiveProjectId,
      });
    }
    return this.effectiveAttachmentsService!.batchRenameAttachments(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  private async resolveAttachmentItemId(attachmentId: string): Promise<string> {
    return this.effectiveAttachmentsService!.resolveAttachmentItemId(
      attachmentId,
    );
  }

  private sendAttachmentPayload(
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

export const AttachmentsController = AttachmentController;
export type AttachmentsController = AttachmentController;
