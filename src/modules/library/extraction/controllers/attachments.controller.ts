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
import { ProjectAccessGuard, ProjectRoles } from '@/modules/project/access';
import {
  CreateAttachmentDto,
  RenameAttachmentDto,
  BatchRenameAttachmentsDto,
  CaptureSnapshotDto,
} from '@/modules/library/extraction/dto/attachments.dto';
// Services
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import { WebSnapshotService } from '@/modules/library/extraction/services/web-snapshot.service';

/**
 * Unified Library Attachments Controller (`/api/v1/library` and `/api/v1/projects/:projectId/library`).
 * Enforces JwtAuthGuard and ProjectAccessGuard (which allows user-scoped routes without :projectId).
 */
@ApiTags('Library Attachments')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class AttachmentController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    @Optional()
    private readonly webSnapshotService?: WebSnapshotService,
  ) {}

  @Get('attachments/:attachmentId/thumbnail')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get thumbnail image for an attachment' })
  async getAttachmentThumbnail(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    const thumbnail = await this.attachmentsService.getThumbnail(
      userId,
      attachmentId,
      projectId,
    );

    res.header('Content-Type', thumbnail?.mimeType || 'image/webp');
    res.header('Cache-Control', 'private, max-age=86400');
    res.header('Vary', 'Authorization');
    return res.send(thumbnail?.buffer || Buffer.from(''));
  }

  @Get('items/:itemId/attachments')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get all attachments for a library item' })
  async getItemAttachments(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.attachmentsService.getItemAttachments(
      userId,
      itemId,
      paramProjectId || queryProjectId,
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
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    return this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      paramProjectId || queryProjectId,
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
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    const itemId = paramItemId || dto.itemId;
    if (!itemId) {
      throw new NotFoundException(
        'Target itemId is required for attachment creation',
      );
    }

    return this.attachmentsService.createAttachment(
      {
        ...dto,
        userId,
        itemId,
      },
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/:attachmentId/re-extract')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger re-extraction on an attachment' })
  async reExtractAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.attachmentsService.reExtractAttachment(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Delete('attachments/:attachmentId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment' })
  async deleteAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.attachmentsService.deleteAttachment(
      userId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Post([
    'attachments/:attachmentId/set-primary',
    'items/:itemId/attachments/:attachmentId/set-primary',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set attachment as primary PDF for item' })
  async setPrimaryAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') paramItemId?: string,
    @Query('itemId') queryItemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    const resolvedItemId =
      paramItemId ||
      queryItemId ||
      (await this.resolveAttachmentItemId(attachmentId, userId));

    return this.attachmentsService.setPrimaryAttachment(
      userId,
      resolvedItemId,
      attachmentId,
      paramProjectId || queryProjectId,
    );
  }

  @Patch(['attachments/:attachmentId', 'attachments/:attachmentId/rename'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Rename attachment file' })
  async renameAttachment(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: RenameAttachmentDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    return this.attachmentsService.renameAttachment(
      userId,
      attachmentId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('attachments/batch-rename')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Batch rename attachments' })
  async batchRenameAttachments(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchRenameAttachmentsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    return this.attachmentsService.batchRenameAttachments(
      userId,
      dto,
      paramProjectId || queryProjectId,
    );
  }

  @Post('items/:itemId/attachments/snapshot')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Capture and archive a web snapshot for an item URL',
  })
  async captureWebSnapshot(
    @CurrentUser('id') userId: string,
    @Param('itemId') itemId: string,
    @Body() body: CaptureSnapshotDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId', new ParseUUIDPipe({ optional: true }))
    paramProjectId?: string,
  ) {
    if (!this.webSnapshotService) {
      throw new NotFoundException(
        'Web snapshot capability is disabled or unconfigured',
      );
    }
    const projectId = paramProjectId || queryProjectId;
    const targetUrl =
      body?.url?.trim() ||
      (await this.attachmentsService.resolveItemUrl(itemId, userId, projectId));
    return this.webSnapshotService.captureAndAttach(targetUrl, itemId, userId, {
      title: body?.title,
      projectId,
    });
  }

  private async resolveAttachmentItemId(
    attachmentId: string,
    userId?: string,
  ): Promise<string> {
    const att = await this.attachmentsService.assertAttachmentExists(
      attachmentId,
      userId,
    );
    return att?.itemId || '';
  }
}

