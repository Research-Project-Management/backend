import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  NotFoundException,
  HttpStatus,
  HttpCode,
  Res,
  Optional,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import {
  CreateAttachmentDto,
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from './dto/attachments.dto';
import { AttachmentsService } from './core/services/attachments.service';
import { WebSnapshotService } from './core/adapters/web-snapshot.service';
import { AttachmentStorageController } from './attachment-storage.controller';
import { toValidProjectId } from '../shared-kernel';

// Re-export Storage & Ingestion Controller for backwards compatibility & modularity
export { AttachmentStorageController } from './attachment-storage.controller';

// CQRS Use Cases
import { CreateAttachmentUseCase } from './core/use-cases/create-attachment.use-case';
import { DeleteAttachmentUseCase } from './core/use-cases/delete-attachment.use-case';
import { SetPrimaryAttachmentUseCase } from './core/use-cases/set-primary-attachment.use-case';
import { RenameAttachmentUseCase } from './core/use-cases/rename-attachment.use-case';
import { BatchRenameAttachmentsUseCase } from './core/use-cases/batch-rename-attachments.use-case';
import { GetAttachmentUseCase } from './core/use-cases/get-attachment.use-case';
import { GetItemAttachmentsUseCase } from './core/use-cases/get-item-attachments.use-case';
import { GetAttachmentThumbnailUseCase } from './core/use-cases/get-attachment-thumbnail.use-case';

/**
 * Dedicated Controller for Attachment Entity Lifecycle, Metadata, Thumbnails, and Snapshots.
 * Independent and decoupled from binary storage operations in AttachmentStorageController.
 */
@ApiTags('Library Attachments - Lifecycle')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AttachmentController {
  constructor(
    @Optional()
    private readonly createAttachmentUseCase?: CreateAttachmentUseCase,
    @Optional()
    private readonly getAttachmentUseCase?: GetAttachmentUseCase,
    @Optional()
    private readonly getItemAttachmentsUseCase?: GetItemAttachmentsUseCase,
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
    @Optional()
    private readonly webSnapshotService?: WebSnapshotService,
    @Optional()
    private readonly attachmentsService?: AttachmentsService,
  ) {}

  /**
   * Stream / serve attachment thumbnail by attachment ID.
   * Cached in browser privately for 24h with Vary: Authorization.
   */
  @Get([
    'attachments/:attachmentId/thumbnail',
    'items/:itemId/attachments/:attachmentId/thumbnail',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get thumbnail image for an attachment' })
  async getAttachmentThumbnail(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );

    let thumbnail: { buffer: Buffer; mimeType: string };
    if (this.getThumbnailUseCase?.execute) {
      thumbnail = await this.getThumbnailUseCase.execute({
        userId,
        attachmentId,
        projectId: effectiveProjectId,
      });
    } else if (this.attachmentsService?.getThumbnail) {
      thumbnail = await this.attachmentsService.getThumbnail(
        userId,
        attachmentId,
        effectiveProjectId,
      );
    } else {
      throw new NotFoundException('Thumbnail generator service unavailable');
    }

    res.header('Content-Type', thumbnail.mimeType || 'image/webp');
    res.header('Cache-Control', 'private, max-age=86400');
    res.header('Vary', 'Authorization');
    return res.send(thumbnail.buffer);
  }

  @Get('items/:itemId/attachments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all attachments for a library item' })
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.getItemAttachmentsUseCase?.execute) {
      return this.getItemAttachmentsUseCase.execute({
        itemId,
        userId,
        projectId: effectiveProjectId,
      });
    }
    return this.attachmentsService!.getItemAttachments(
      userId,
      itemId,
      effectiveProjectId,
    );
  }

  @Get(['items/:itemId/attachments/:attachmentId', 'attachments/:attachmentId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get attachment details by ID' })
  async getItemAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.getAttachmentUseCase?.execute) {
      return (this.getAttachmentUseCase.execute as any)(
        userId,
        itemId,
        attachmentId,
        effectiveProjectId,
      );
    }
    return this.attachmentsService!.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Post(['items/:itemId/attachments', 'attachments'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and associate a new attachment' })
  async createAttachment(
    @CurrentUser('id') userId: string,
    @Param('itemId') paramItemId: string | undefined,
    @Body() dto: CreateAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    const itemId = paramItemId || (dto as any).itemId;
    if (!itemId) {
      throw new NotFoundException(
        'Target itemId is required for attachment creation',
      );
    }

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
    return this.attachmentsService!.createAttachment(
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
  @ApiOperation({ summary: 'Trigger re-extraction and OCR on an attachment' })
  async reExtractAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.attachmentsService!.reExtractAttachment(
      userId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Delete('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment' })
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.deleteAttachmentUseCase?.execute) {
      return this.deleteAttachmentUseCase.execute({
        userId,
        attachmentId,
        projectId: effectiveProjectId,
      });
    }
    return this.attachmentsService!.deleteAttachment(
      userId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Post('attachments/:attachmentId/primary')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set attachment as primary PDF for item' })
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('itemId') queryItemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    const resolvedItemId =
      queryItemId || (await this.resolveAttachmentItemId(attachmentId));

    if (this.setPrimaryAttachmentUseCase?.execute) {
      return this.setPrimaryAttachmentUseCase.execute({
        userId,
        itemId: resolvedItemId,
        attachmentId,
        projectId: effectiveProjectId,
      });
    }
    return this.attachmentsService!.setPrimaryAttachment(
      userId,
      resolvedItemId,
      attachmentId,
      effectiveProjectId,
    );
  }

  @Patch('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Rename attachment file' })
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
    return this.attachmentsService!.renameAttachment(
      userId,
      attachmentId,
      dto,
      effectiveProjectId,
    );
  }

  @Post('attachments/batch-rename')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Batch rename multiple attachments according to citation pattern',
  })
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
    return this.attachmentsService!.batchRenameAttachments(
      userId,
      dto,
      effectiveProjectId,
    );
  }

  @Post('items/:itemId/snapshot')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and archive a web snapshot for an item URL',
  })
  async captureWebSnapshot(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() body: { url: string; title?: string },
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (!this.webSnapshotService) {
      throw new NotFoundException(
        'Web snapshot capability is disabled or unconfigured',
      );
    }
    return this.webSnapshotService.captureAndAttach(body.url, itemId, userId, {
      title: body.title,
    });
  }

  private async resolveAttachmentItemId(attachmentId: string): Promise<string> {
    if (this.attachmentsService?.resolveAttachmentItemId) {
      return this.attachmentsService.resolveAttachmentItemId(attachmentId);
    }
    if (this.getAttachmentUseCase?.execute) {
      const att = await this.getAttachmentUseCase.execute(attachmentId);
      if (att && (att as any).itemId) return (att as any).itemId;
    }
    return '';
  }
}

export const AttachmentsController = AttachmentController;
export type AttachmentsController = AttachmentController;
