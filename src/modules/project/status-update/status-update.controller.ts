import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { StatusUpdateService } from './status-update.service';
import { CreateProjectStatusUpdateDto } from './dto/create-status-update.dto';
import { UpdateProjectStatusUpdateDto } from './dto/update-status-update.dto';

@ApiTags('Project Status Updates')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class StatusUpdateController {
  constructor(private readonly service: StatusUpdateService) {}

  @Get(':projectId/updates')
  @ApiOperation({
    summary: 'List all status updates for a project (chronological)',
  })
  @ApiResponse({ status: 200, description: 'List of status updates' })
  getUpdates(@Param('projectId') projectId: string) {
    return this.service.getUpdates(projectId);
  }

  @Get(':projectId/updates/latest')
  @ApiOperation({ summary: 'Get the latest status update for a project' })
  @ApiResponse({ status: 200, description: 'Latest status update or null' })
  getLatestUpdate(@Param('projectId') projectId: string) {
    return this.service.getLatestUpdate(projectId);
  }

  @Post(':projectId/updates')
  @ApiOperation({ summary: 'Post a new status update for a project' })
  @ApiResponse({
    status: 201,
    description: 'Status update created successfully',
  })
  createUpdate(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectStatusUpdateDto,
  ) {
    return this.service.createUpdate(projectId, userId, dto);
  }

  @Patch(':projectId/updates/:updateId')
  @ApiOperation({ summary: 'Edit an existing status update' })
  @ApiResponse({
    status: 200,
    description: 'Status update updated successfully',
  })
  updateUpdate(
    @Param('projectId') projectId: string,
    @Param('updateId') updateId: string,
    @Body() dto: UpdateProjectStatusUpdateDto,
  ) {
    return this.service.updateUpdate(projectId, updateId, dto);
  }

  @Delete(':projectId/updates/:updateId')
  @ApiOperation({ summary: 'Delete a status update' })
  @ApiResponse({
    status: 200,
    description: 'Status update deleted successfully',
  })
  deleteUpdate(
    @Param('projectId') projectId: string,
    @Param('updateId') updateId: string,
  ) {
    return this.service.deleteUpdate(projectId, updateId);
  }
}
