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
import { AttachmentsService } from '../application/services/attachments.service';
import { WebSnapshotService } from '../application/services/web-snapshot.service';
import {
  CreateAttachmentDto,
  ReplaceAttachmentFileDto,
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from '../application/dtos/attachments.dto';
import { JwtAuthGuard } from '../../../iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../iam/authz/decorators/role.decorator';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { isUUID } from 'class-validator';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly webSnapshotService: WebSnapshotService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

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

  /**
   * Phase 2: Get presigned PUT URL for an individual part.
   */
  @Get([
    'attachments/multipart/:sessionId/part-url',
    'multipart/:sessionId/part-url',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async getMultipartPartUrl(
    @Param('sessionId') sessionId: string,
    @Query('partNumber') partNumberStr: string,
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
    );
    return { partNumber, partUrl };
  }

  /**
   * Phase 3: Complete multipart upload and assemble object in S3/R2.
   */
  @Post(['attachments/multipart/complete', 'multipart/complete'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  async completeMultipart(
    @Body()
    dto: {
      sessionId: string;
      parts: { partNumber: number; eTag: string }[];
    },
  ) {
    if (!this.storagePort?.completeMultipartUpload) {
      throw new BadRequestException('Multipart completion unavailable');
    }

    return this.storagePort.completeMultipartUpload({
      sessionId: dto.sessionId,
      parts: dto.parts,
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
  async abortMultipart(@Param('sessionId') sessionId: string) {
    if (this.storagePort?.abortMultipartUpload) {
      await this.storagePort.abortMultipartUpload(sessionId);
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
  ) {
    if (!this.storagePort?.readOwnedFile) {
      throw new NotFoundException('Storage port unavailable');
    }

    const fileRecord = await this.storagePort.readOwnedFile({
      fileId,
      userId,
    });

    res.header('Content-Type', fileRecord.mimeType || 'application/pdf');
    res.header(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(fileRecord.filename)}"`,
    );
    res.header('Content-Length', fileRecord.size);
    res.header(
      'Cache-Control',
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    return res.send(fileRecord.buffer);
  }

  /**
   * Stream / serve attachment content by attachment ID.
   */
  @Get('attachments/:attachmentId/content')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async streamAttachmentContent(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    const result = await this.attachmentsService.getItemAttachment(
      userId,
      undefined,
      attachmentId,
      effectiveProjectId,
    );
    const attachment = (result as any)?.attachment || result;

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort?.readOwnedFile) {
      const fileRecord = await this.storagePort.readOwnedFile({
        fileId: attachment.fileId,
        userId,
      });

      res.header(
        'Content-Type',
        fileRecord.mimeType || attachment.mimeType || 'application/pdf',
      );
      res.header(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(attachment.filename || fileRecord.filename)}"`,
      );
      res.header('Content-Length', fileRecord.size);
      return res.send(fileRecord.buffer);
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
   * Cached in browser for 24h (Cache-Control: public, max-age=86400).
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
    const thumbnail = await this.attachmentsService.getThumbnail(
      userId,
      attachmentId,
      effectiveProjectId,
    );

    res.header('Content-Type', thumbnail.mimeType || 'image/webp');
    res.header('Cache-Control', 'public, max-age=86400');
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
    return this.attachmentsService.getItemAttachments(
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
    return this.attachmentsService.getItemAttachment(
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
    return this.attachmentsService.createAttachment(
      {
        ...dto,
        userId,
        itemId,
      },
      effectiveProjectId,
    );
  }

  @Get('attachments/:attachmentId/revisions')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  async getRevisions(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const revisions = await this.attachmentsService.getRevisions(
      userId,
      attachmentId,
      effectiveProjectId,
    );
    return { revisions };
  }

  @Post('attachments/:attachmentId/revisions')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  async addRevision(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: ReplaceAttachmentFileDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.attachmentsService.addRevision(
      userId,
      attachmentId,
      dto,
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
    return this.attachmentsService.deleteAttachment(
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
    return this.attachmentsService.setPrimaryAttachment(
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
    const scopeWhere = effectiveProjectId
      ? { projectId: effectiveProjectId }
      : { userId };

    let targetUrl = body?.url?.trim();
    if (!targetUrl) {
      targetUrl = await this.attachmentsService.resolveItemUrl(
        itemId,
        userId,
        effectiveProjectId,
      );
    }

    return this.webSnapshotService.captureAndAttach(targetUrl, itemId, userId, {
      title: body?.title,
    });
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
    return this.attachmentsService.renameAttachment(
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
    return this.attachmentsService.batchRenameAttachments(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  private async resolveAttachmentItemId(attachmentId: string): Promise<string> {
    return this.attachmentsService.resolveAttachmentItemId(attachmentId);
  }
}
