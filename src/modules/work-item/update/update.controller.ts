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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Work Item Updates')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class UpdateController {
  constructor(private readonly updateService: UpdateService) {}

  @Get([
    'projects/:projectId/work-items/:workItemId/updates',
    'work-items/:workItemId/updates',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get all status updates for a work item' })
  @ApiParam({ name: 'workItemId', description: 'Work item ID' })
  @ApiResponse({
    status: 200,
    description: 'List of status updates, newest first',
  })
  async getUpdates(@Param('workItemId') workItemId: string) {
    return this.updateService.getUpdates(workItemId);
  }

  @Get([
    'projects/:projectId/work-items/:workItemId/updates/latest',
    'work-items/:workItemId/updates/latest',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Get the most recent status update for a work item',
  })
  @ApiResponse({ status: 200, description: 'Latest status update or null' })
  async getLatestUpdate(@Param('workItemId') workItemId: string) {
    return this.updateService.getLatestUpdate(workItemId);
  }

  @Post([
    'projects/:projectId/work-items/:workItemId/updates',
    'work-items/:workItemId/updates',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({
    summary:
      'Post a status update (On Track / At Risk / Off Track) on a work item',
  })
  @ApiResponse({ status: 201, description: 'Update created successfully' })
  async addUpdate(
    @Param('workItemId') workItemId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorkItemUpdateDto,
  ) {
    return this.updateService.addUpdate(workItemId, userId, dto);
  }

  @Delete([
    'projects/:projectId/work-items/:workItemId/updates/:updateId',
    'work-items/:workItemId/updates/:updateId',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Delete a specific status update from a work item' })
  @ApiResponse({ status: 200, description: 'Update deleted successfully' })
  async deleteUpdate(
    @Param('workItemId') workItemId: string,
    @Param('updateId') updateId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.updateService.deleteUpdate(workItemId, updateId, userId);
  }
}
