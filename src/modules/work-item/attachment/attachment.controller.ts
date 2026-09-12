import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';
import { AttachmentService } from './attachment.service';
import { CreateAttachmentDto } from './dto/attachment.dto';

@ApiTags('Work Item Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(
    private readonly attachmentService: AttachmentService,
  ) {}

  @Get([
    'work-items/:taskId/attachments',
    'tasks/:taskId/attachments',
    'projects/:projectId/work-items/:taskId/attachments',
    'project/:projectId/work-items/:taskId/attachments',
    'projects/:projectId/tasks/:taskId/attachments',
    'project/:projectId/tasks/:taskId/attachments',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all attachments for a work item' })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async getAttachments(@Param('taskId') taskId: string) {
    return this.attachmentService.getAttachments(taskId);
  }

  @Post([
    'work-items/:taskId/attachments',
    'tasks/:taskId/attachments',
    'projects/:projectId/work-items/:taskId/attachments',
    'project/:projectId/work-items/:taskId/attachments',
    'projects/:projectId/tasks/:taskId/attachments',
    'project/:projectId/tasks/:taskId/attachments',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an attachment to a work item' })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  async addAttachment(
    @Param('taskId') taskId: string,
    @Body() dto: CreateAttachmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.addAttachment(taskId, dto, userId);
  }

  @Delete([
    'work-items/:taskId/attachments/:attachmentId',
    'tasks/:taskId/attachments/:attachmentId',
    'projects/:projectId/work-items/:taskId/attachments/:attachmentId',
    'project/:projectId/work-items/:taskId/attachments/:attachmentId',
    'projects/:projectId/tasks/:taskId/attachments/:attachmentId',
    'project/:projectId/tasks/:taskId/attachments/:attachmentId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Delete an attachment from a work item' })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  async removeAttachment(
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.removeAttachment(taskId, attachmentId, userId);
  }
}
