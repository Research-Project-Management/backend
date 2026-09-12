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
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { UpdateService } from './update.service';
import { CreateWorkItemUpdateDto } from './dto/update.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Work Item Updates')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class UpdateController {
  constructor(private readonly updateService: UpdateService) {}

  @Get([
    'projects/:projectId/work-items/:taskId/updates',
    'work-items/:taskId/updates',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all status updates for a work item' })
  @ApiParam({ name: 'taskId', description: 'Work item ID' })
  @ApiResponse({ status: 200, description: 'List of status updates, newest first' })
  async getUpdates(@Param('taskId') taskId: string) {
    return this.updateService.getUpdates(taskId);
  }

  @Get([
    'projects/:projectId/work-items/:taskId/updates/latest',
    'work-items/:taskId/updates/latest',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get the most recent status update for a work item' })
  @ApiResponse({ status: 200, description: 'Latest status update or null' })
  async getLatestUpdate(@Param('taskId') taskId: string) {
    return this.updateService.getLatestUpdate(taskId);
  }

  @Post([
    'projects/:projectId/work-items/:taskId/updates',
    'work-items/:taskId/updates',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({
    summary: 'Post a status update (On Track / At Risk / Off Track) on a work item',
  })
  @ApiResponse({ status: 201, description: 'Update created successfully' })
  async addUpdate(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorkItemUpdateDto,
  ) {
    return this.updateService.addUpdate(taskId, userId, dto);
  }

  @Delete([
    'projects/:projectId/work-items/:taskId/updates/:updateId',
    'work-items/:taskId/updates/:updateId',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @ApiOperation({ summary: 'Delete a specific status update from a work item' })
  @ApiResponse({ status: 200, description: 'Update deleted successfully' })
  async deleteUpdate(
    @Param('taskId') taskId: string,
    @Param('updateId') updateId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.updateService.deleteUpdate(taskId, updateId, userId);
  }
}

