import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
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
import { AttachmentsService } from './attachments.service';
import { WebSnapshotService } from './services/web-snapshot.service';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  CreateAttachmentDto,
  ReplaceAttachmentFileDto,
} from './dto/attachments.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { IStoragePort, STORAGE_PORT } from '../../storage/storage.port';

@Controller([
  'api/v1/workspaces/:workspaceId/library/items/:itemId/attachments',
  'api/v1/workspaces/:workspaceId/library/attachments',
  'api/v1/workspace/:workspaceId/library/items/:itemId/attachments',
  'api/v1/workspace/:workspaceId/library/attachments',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly webSnapshotService: WebSnapshotService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  /**
   * Library Bounded Context Upload Gateway.
   * Frontend library uploads files through this gateway without directly referencing StorageModule.
   */
  @Post(['upload', 'files/upload'])
  @HttpCode(HttpStatus.CREATED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async uploadLibraryFile(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
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
        'No file payload received in multipart request',
      );
    }

    const uploaded = await this.storagePort.uploadFile({
      workspaceId,
      userId,
      filename,
      buffer,
      mimeType,
      source: 'library',
    });

    return {
      success: true,
      data: uploaded,
    };
  }

  /**
   * Stream / serve library file content scoped by workspace tenant access.
   */
  @Get('files/:fileId/content')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async streamLibraryFile(
    @Param('workspaceId') workspaceId: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
  ) {
    if (!this.storagePort?.readOwnedFile) {
      throw new NotFoundException('Storage port unavailable');
    }

    const fileRecord = await this.storagePort.readOwnedFile({
      workspaceId,
      fileId,
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
  @Get(':attachmentId/content')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async streamAttachmentContent(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: FastifyReply,
  ) {
    const result = await this.attachmentsService.getItemAttachment(
      workspaceId,
      undefined,
      attachmentId,
    );
    const attachment = (result as any)?.attachment || result;

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    if (attachment.fileId && this.storagePort?.readOwnedFile) {
      const fileRecord = await this.storagePort.readOwnedFile({
        workspaceId,
        fileId: attachment.fileId,
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

  @Get()
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getItemAttachments(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.attachmentsService.getItemAttachments(workspaceId, itemId);
  }

  @Get(':attachmentId')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getItemAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @Param('itemId') itemId?: string,
  ) {
    return this.attachmentsService.getItemAttachment(
      workspaceId,
      itemId,
      attachmentId,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachmentsService.createAttachment({
      ...dto,
      workspaceId,
      itemId: itemId,
    });
  }

  @Get(':attachmentId/revisions')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getRevisions(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const revisions = await this.attachmentsService.getRevisions(
      workspaceId,
      attachmentId,
    );
    return { revisions };
  }

  @Post(':attachmentId/revisions')
  @HttpCode(HttpStatus.CREATED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async addRevision(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: ReplaceAttachmentFileDto,
  ) {
    return this.attachmentsService.addRevision(workspaceId, attachmentId, dto);
  }

  @Delete(':attachmentId')
  @WorkspaceRoles('owner', 'admin')
  async deleteAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(workspaceId, attachmentId);
  }

  @Post(':attachmentId/set-primary')
  @WorkspaceRoles('owner', 'admin', 'member')
  async setPrimaryAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.setPrimaryAttachment(
      workspaceId,
      itemId,
      attachmentId,
    );
  }

  @Post('snapshot')
  @HttpCode(HttpStatus.CREATED)
  @WorkspaceRoles('owner', 'admin', 'member')
  async captureSnapshot(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() body?: { url?: string; title?: string },
  ) {
    let targetUrl = body?.url?.trim();
    if (!targetUrl) {
      const item = await this.prisma.item.findFirst({
        where: { id: itemId, workspaceId, deletedAt: null },
        select: { url: true, title: true },
      });
      if (!item) {
        throw new NotFoundException(
          `Item ${itemId} not found in this workspace`,
        );
      }
      if (!item.url) {
        throw new BadRequestException(
          'No URL found on this item to capture a snapshot.',
        );
      }
      targetUrl = item.url;
    }

    return this.webSnapshotService.captureAndAttach(
      targetUrl,
      itemId,
      workspaceId,
      { title: body?.title },
    );
  }
}
