import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { AttachmentService } from './attachment.service';
import {
  CreateAttachmentDto,
  AttachPageDto,
  AttachPaperDto,
  AttachFileDto,
  AttachLinkDto,
} from './dto/attachment.dto';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';

@ApiTags('Work Item Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Get('work-items/:workItemId/attachments')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all attachments for a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async getAttachments(@Param('workItemId') workItemId: string) {
    return this.attachmentService.getAttachments(workItemId);
  }

  @Post('work-items/:workItemId/attachments')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an attachment to a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async addAttachment(
    @Param('workItemId') workItemId: string,
    @Body() dto: CreateAttachmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.addAttachment(workItemId, dto, userId);
  }

  @Delete('work-items/:workItemId/attachments/:attachmentId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment from a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  async removeAttachment(
    @Param('workItemId') workItemId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.removeAttachment(
      workItemId,
      attachmentId,
      userId,
    );
  }

  @Post('work-items/:workItemId/attach/pages')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a page to a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async attachPage(
    @Param('workItemId') workItemId: string,
    @Body() dto: AttachPageDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.attachPage(workItemId, dto, userId);
  }

  @Delete('work-items/:workItemId/attach/pages/:pageId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Detach a page from a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  @ApiParam({ name: 'pageId', description: 'Page ID' })
  async detachPage(
    @Param('workItemId') workItemId: string,
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.detachPage(workItemId, pageId, userId);
  }

  @Post('work-items/:workItemId/attach/papers')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a research paper to a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async attachPaper(
    @Param('workItemId') workItemId: string,
    @Body() dto: AttachPaperDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.attachPaper(workItemId, dto, userId);
  }

  @Delete('work-items/:workItemId/attach/papers/:paperId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Detach a research paper from a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  @ApiParam({ name: 'paperId', description: 'Paper ID' })
  async detachPaper(
    @Param('workItemId') workItemId: string,
    @Param('paperId') paperId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.detachPaper(workItemId, paperId, userId);
  }

  @Post('work-items/:workItemId/attach/files')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a file to a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async attachFile(
    @Param('workItemId') workItemId: string,
    @Body() dto: AttachFileDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.attachFile(workItemId, dto, userId);
  }

  @Delete('work-items/:workItemId/attach/files/:fileId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Detach a file from a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  @ApiParam({ name: 'fileId', description: 'File ID' })
  async detachFile(
    @Param('workItemId') workItemId: string,
    @Param('fileId') fileId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.detachFile(workItemId, fileId, userId);
  }

  @Post('work-items/:workItemId/attach/links')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach an external link to a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  async attachLink(
    @Param('workItemId') workItemId: string,
    @Body() dto: AttachLinkDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.attachLink(workItemId, dto, userId);
  }

  @Delete('work-items/:workItemId/attach/links/:linkIndex')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Detach an external link from a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  @ApiParam({ name: 'linkIndex', description: 'Link index or ID' })
  async detachLink(
    @Param('workItemId') workItemId: string,
    @Param('linkIndex') linkIndex: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.detachLink(workItemId, linkIndex, userId);
  }

  @Post('work-items/:workItemId/attachments/presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate presigned URL for direct attachment upload',
  })
  async presign(
    @Body() dto: PresignAttachmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.generatePresignedUpload(dto, userId);
  }

  @Post(['attachments/upload', 'work-items/:workItemId/attachments/upload'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Multipart stream upload attachment directly' })
  async upload(@Req() req: FastifyRequest, @CurrentUser('id') userId: string) {
    return this.attachmentService.uploadMultipart(req, userId);
  }

  @Get('attachments/:id')
  @ApiOperation({ summary: 'Get single attachment metadata by ID' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  async getOne(@Param('id') id: string) {
    return this.attachmentService.getAttachmentById(id);
  }

  @Delete('attachments/:id')
  @ApiOperation({ summary: 'Delete attachment by ID' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  async deleteOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.attachmentService.deleteAttachment(id, userId);
  }
}
