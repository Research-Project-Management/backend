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
  ParseUUIDPipe,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import {
  CreateAttachmentDto,
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
} from './dto/attachments.dto';
import { AttachmentsService } from './core/services/attachments.service';
import { WebSnapshotService } from './core/adapters/web-snapshot.service';
import {
  AttachmentStorageController,
  ProjectAttachmentStorageController,
} from './attachment-storage.controller';

// Re-export Storage & Ingestion Controller for backwards compatibility & modularity
export {
  AttachmentStorageController,
  ProjectAttachmentStorageController,
} from './attachment-storage.controller';

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
 * Shared Base Adapter for Library Attachments Use-Case orchestration.
 */
export abstract class BaseAttachmentController {
  constructor(
    protected readonly createAttachmentUseCase: CreateAttachmentUseCase,
    protected readonly getAttachmentUseCase: GetAttachmentUseCase,
    protected readonly getItemAttachmentsUseCase: GetItemAttachmentsUseCase,
    protected readonly deleteAttachmentUseCase: DeleteAttachmentUseCase,
    protected readonly setPrimaryAttachmentUseCase: SetPrimaryAttachmentUseCase,
    protected readonly renameAttachmentUseCase: RenameAttachmentUseCase,
    protected readonly batchRenameAttachmentsUseCase: BatchRenameAttachmentsUseCase,
    protected readonly getThumbnailUseCase: GetAttachmentThumbnailUseCase,
    @Optional()
    protected readonly webSnapshotService?: WebSnapshotService,
    @Optional()
    protected readonly attachmentsService?: AttachmentsService,
  ) {}

  protected async executeGetAttachmentThumbnail(
    userId: string,
    attachmentId: string,
    res: FastifyReply,
    projectId?: string,
  ) {
    const thumbnail = await this.getThumbnailUseCase.execute({
      userId,
      attachmentId,
      projectId,
    });

    res.header('Content-Type', thumbnail.mimeType || 'image/webp');
    res.header('Cache-Control', 'private, max-age=86400');
    res.header('Vary', 'Authorization');
    return res.send(thumbnail.buffer);
  }

  protected async executeGetItemAttachments(
    userId: string,
    itemId: string,
    projectId?: string,
  ) {
    return this.getItemAttachmentsUseCase.execute({
      itemId,
      userId,
      projectId,
    });
  }

  protected async executeGetItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ) {
    return this.getAttachmentUseCase.execute(
      userId,
      itemId,
      attachmentId,
      projectId,
    );
  }

  protected async executeCreateAttachment(
    userId: string,
    paramItemId: string | undefined,
    dto: CreateAttachmentDto,
    projectId?: string,
  ) {
    const itemId = paramItemId || (dto as any).itemId;
    if (!itemId) {
      throw new NotFoundException(
        'Target itemId is required for attachment creation',
      );
    }

    return this.createAttachmentUseCase.execute(
      {
        ...dto,
        userId,
        itemId,
      },
      projectId,
    );
  }

  protected async executeReExtractAttachment(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ) {
    if (!this.attachmentsService) {
      throw new NotFoundException('Attachment processing service unavailable');
    }
    return this.attachmentsService.reExtractAttachment(
      userId,
      attachmentId,
      projectId,
    );
  }

  protected async executeDeleteAttachment(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ) {
    return this.deleteAttachmentUseCase.execute({
      userId,
      attachmentId,
      projectId,
    });
  }

  protected async executeSetPrimaryAttachment(
    userId: string,
    attachmentId: string,
    queryItemId?: string,
    projectId?: string,
  ) {
    const resolvedItemId =
      queryItemId || (await this.resolveAttachmentItemId(attachmentId));

    return this.setPrimaryAttachmentUseCase.execute({
      userId,
      itemId: resolvedItemId,
      attachmentId,
      projectId,
    });
  }

  protected async executeRenameAttachment(
    userId: string,
    attachmentId: string,
    dto: RenameAttachmentDto,
    projectId?: string,
  ) {
    return this.renameAttachmentUseCase.execute({
      userId,
      attachmentId,
      dto,
      projectId,
    });
  }

  protected async executeBatchRenameAttachments(
    userId: string,
    dto: BatchRenameAttachmentsDto,
    projectId?: string,
  ) {
    return this.batchRenameAttachmentsUseCase.execute({
      userId,
      dto,
      projectId,
    });
  }

  protected async executeCaptureWebSnapshot(
    userId: string,
    itemId: string,
    body: { url: string; title?: string },
  ) {
    if (!this.webSnapshotService) {
      throw new NotFoundException(
        'Web snapshot capability is disabled or unconfigured',
      );
    }
    return this.webSnapshotService.captureAndAttach(body.url, itemId, userId, {
      title: body.title,
    });
  }

  protected async resolveAttachmentItemId(
    attachmentId: string,
  ): Promise<string> {
    if (this.attachmentsService?.resolveAttachmentItemId) {
      return this.attachmentsService.resolveAttachmentItemId(attachmentId);
    }
    const att = await this.getAttachmentUseCase.execute(attachmentId);
    if (att && (att as any).itemId) return (att as any).itemId;
    return '';
  }
}

/**
 * Personal Library Attachments Controller (/api/v1/library).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Attachments - Personal Lifecycle')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library')
@UseGuards(JwtAuthGuard)
export class AttachmentController extends BaseAttachmentController {
  constructor(
    createAttachmentUseCase: CreateAttachmentUseCase,
    getAttachmentUseCase: GetAttachmentUseCase,
    getItemAttachmentsUseCase: GetItemAttachmentsUseCase,
    deleteAttachmentUseCase: DeleteAttachmentUseCase,
    setPrimaryAttachmentUseCase: SetPrimaryAttachmentUseCase,
    renameAttachmentUseCase: RenameAttachmentUseCase,
    batchRenameAttachmentsUseCase: BatchRenameAttachmentsUseCase,
    getThumbnailUseCase: GetAttachmentThumbnailUseCase,
    @Optional()
    webSnapshotService?: WebSnapshotService,
    @Optional()
    attachmentsService?: AttachmentsService,
  ) {
    super(
      createAttachmentUseCase,
      getAttachmentUseCase,
      getItemAttachmentsUseCase,
      deleteAttachmentUseCase,
      setPrimaryAttachmentUseCase,
      renameAttachmentUseCase,
      batchRenameAttachmentsUseCase,
      getThumbnailUseCase,
      webSnapshotService,
      attachmentsService,
    );
  }

  @Get([
    'attachments/:attachmentId/thumbnail',
    'items/:itemId/attachments/:attachmentId/thumbnail',
  ])
  @ApiOperation({ summary: 'Get thumbnail image for a personal attachment' })
  async getAttachmentThumbnail(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeGetAttachmentThumbnail(
      userId,
      attachmentId,
      res,
      paramProjectId || queryProjectId,
    );
  }

  @Get('items/:itemId/attachments')
  @ApiOperation({ summary: 'Get all attachments for a personal library item' })
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeGetItemAttachments(
      userId,
      itemId,
      paramProjectId || queryProjectId,
    );
  }

  @Get(['items/:itemId/attachments/:attachmentId', 'attachments/:attachmentId'])
  @ApiOperation({ summary: 'Get personal attachment details by ID' })
  async getItemAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeGetItemAttachment(
      userId,
      attachmentId,
      itemId,
      paramProjectId || queryProjectId,
    );
  }

  @Post(['items/:itemId/attachments', 'attachments'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and associate a new personal attachment' })
  async createAttachment(
    @CurrentUser('id') userId: string,
    @Param('itemId') paramItemId: string | undefined,
    @Body() dto: CreateAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeCreateAttachment(
      userId,
      paramItemId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/:attachmentId/re-extract')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger re-extraction on a personal attachment' })
  async reExtractAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeReExtractAttachment(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Delete('attachments/:attachmentId')
  @ApiOperation({ summary: 'Delete a personal attachment' })
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeDeleteAttachment(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/:attachmentId/primary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set attachment as primary PDF for personal item' })
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('itemId') queryItemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeSetPrimaryAttachment(
      userId,
      attachmentId,
      queryItemId,
      paramProjectId || queryProjectId,
    );
  }

  @Patch('attachments/:attachmentId')
  @ApiOperation({ summary: 'Rename personal attachment file' })
  async renameAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: RenameAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeRenameAttachment(
      userId,
      attachmentId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/batch-rename')
  @ApiOperation({ summary: 'Batch rename personal attachments' })
  async batchRenameAttachments(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchRenameAttachmentsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeBatchRenameAttachments(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('items/:itemId/snapshot')
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
    return this.executeCaptureWebSnapshot(userId, itemId, body);
  }
}

/**
 * Project Library Attachments Controller (/api/v1/projects/:projectId/library).
 * Strictly validates :projectId with ParseUUIDPipe and enforces project roles.
 */
@ApiTags('Library Attachments - Project Lifecycle')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectAttachmentController extends BaseAttachmentController {
  constructor(
    createAttachmentUseCase: CreateAttachmentUseCase,
    getAttachmentUseCase: GetAttachmentUseCase,
    getItemAttachmentsUseCase: GetItemAttachmentsUseCase,
    deleteAttachmentUseCase: DeleteAttachmentUseCase,
    setPrimaryAttachmentUseCase: SetPrimaryAttachmentUseCase,
    renameAttachmentUseCase: RenameAttachmentUseCase,
    batchRenameAttachmentsUseCase: BatchRenameAttachmentsUseCase,
    getThumbnailUseCase: GetAttachmentThumbnailUseCase,
    @Optional()
    webSnapshotService?: WebSnapshotService,
    @Optional()
    attachmentsService?: AttachmentsService,
  ) {
    super(
      createAttachmentUseCase,
      getAttachmentUseCase,
      getItemAttachmentsUseCase,
      deleteAttachmentUseCase,
      setPrimaryAttachmentUseCase,
      renameAttachmentUseCase,
      batchRenameAttachmentsUseCase,
      getThumbnailUseCase,
      webSnapshotService,
      attachmentsService,
    );
  }

  @Get([
    'attachments/:attachmentId/thumbnail',
    'items/:itemId/attachments/:attachmentId/thumbnail',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get thumbnail image for a project attachment' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getAttachmentThumbnail(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetAttachmentThumbnail(
      userId,
      attachmentId,
      res,
      projectId,
    );
  }

  @Get('items/:itemId/attachments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all attachments for a project library item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetItemAttachments(userId, itemId, projectId);
  }

  @Get(['items/:itemId/attachments/:attachmentId', 'attachments/:attachmentId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project attachment details by ID' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getItemAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('itemId') itemId?: string,
  ) {
    return this.executeGetItemAttachment(
      userId,
      attachmentId,
      itemId,
      projectId,
    );
  }

  @Post(['items/:itemId/attachments', 'attachments'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and associate a new project attachment' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async createAttachment(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateAttachmentDto,
    @Param('itemId') paramItemId?: string,
  ) {
    return this.executeCreateAttachment(userId, paramItemId, dto, projectId);
  }

  @Post('attachments/:attachmentId/re-extract')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger re-extraction on a project attachment' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async reExtractAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeReExtractAttachment(userId, attachmentId, projectId);
  }

  @Delete('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a project attachment' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeDeleteAttachment(userId, attachmentId, projectId);
  }

  @Post('attachments/:attachmentId/primary')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set attachment as primary PDF for project item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('itemId') queryItemId?: string,
  ) {
    return this.executeSetPrimaryAttachment(
      userId,
      attachmentId,
      queryItemId,
      projectId,
    );
  }

  @Patch('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Rename project attachment file' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async renameAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: RenameAttachmentDto,
  ) {
    return this.executeRenameAttachment(userId, attachmentId, dto, projectId);
  }

  @Post('attachments/batch-rename')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Batch rename project attachments' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async batchRenameAttachments(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: BatchRenameAttachmentsDto,
  ) {
    return this.executeBatchRenameAttachments(userId, dto, projectId);
  }

  @Post('items/:itemId/snapshot')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and archive a web snapshot for a project item URL',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async captureWebSnapshot(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() body: { url: string; title?: string },
  ) {
    return this.executeCaptureWebSnapshot(userId, itemId, body);
  }
}

export const AttachmentsController = AttachmentController;
export type AttachmentsController = AttachmentController;
