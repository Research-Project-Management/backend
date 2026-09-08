import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
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
  ) {}

  @Get()
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getItemAttachments(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.attachmentsService.getItemAttachments(workspaceId, itemId);
  }

  @Get(':attachmentId')
  @UseGuards(WorkspaceRoleGuard)
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
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachmentsService.createAttachment({
      ...dto,
      workspaceId,
      catalogItemId: itemId,
    });
  }

  @Get(':attachmentId/revisions')
  @UseGuards(WorkspaceRoleGuard)
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
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async addRevision(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() dto: ReplaceAttachmentFileDto,
  ) {
    return this.attachmentsService.addRevision(workspaceId, attachmentId, dto);
  }

  @Delete(':attachmentId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  async deleteAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(workspaceId, attachmentId);
  }

  @Post('snapshot')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async captureSnapshot(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() body?: { url?: string; title?: string },
  ) {
    let targetUrl = body?.url?.trim();
    if (!targetUrl) {
      const item = await this.prisma.catalogItem.findUnique({
        where: { id: itemId },
        select: { url: true, title: true },
      });
      if (!item?.url) {
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
