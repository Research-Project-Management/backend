import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import {
  CreateAttachmentDto,
  ReplaceAttachmentFileDto,
} from './dto/attachment.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library/attachments',
  'api/workspace/:workspaceId/library/items/:itemId/attachments',
  'api/library/:workspaceId/items/:itemId/attachments',
  'api/library/papers/:workspaceId/:itemId/attachments',
  'api/library/attachments',
])
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

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
    @Param('itemId') itemId: string,
    @Param('attachmentId') attachmentId: string,
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
    @Param('itemId') itemId: string,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachmentsService.createAttachment({
      ...dto,
      catalogItemId: itemId,
    });
  }

  @Get(':attachmentId/revisions')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getRevisions(@Param('attachmentId') attachmentId: string) {
    const revisions = await this.attachmentsService.getRevisions(attachmentId);
    return { revisions };
  }

  @Post(':attachmentId/revisions')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async addRevision(
    @Param('attachmentId') attachmentId: string,
    @Body() dto: ReplaceAttachmentFileDto,
  ) {
    return this.attachmentsService.addRevision(attachmentId, dto);
  }

  @Delete(':attachmentId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async deleteAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(workspaceId, attachmentId);
  }
}
