import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
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
import { WorklogService } from './worklog.service';
import { CreateWorklogDto } from './dto/create-worklog.dto';
import { UpdateWorklogDto } from './dto/update-worklog.dto';
import { QueryWorklogDto } from './dto/query-worklog.dto';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller('api/work-items')
@UseGuards(JwtAuthGuard)
export class WorklogController {
  constructor(private readonly worklogService: WorklogService) {}

  @Post(':taskId/worklogs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Log work / hours spent on a work item' })
  @ApiParam({ name: 'taskId', description: 'Work item UUID or identifier (e.g. FLUX-123)' })
  async logWork(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Body() createWorklogDto: CreateWorklogDto,
  ) {
    return this.worklogService.logWork(taskId, userId, createWorklogDto);
  }

  @Get(':taskId/worklogs')
  @ApiOperation({ summary: 'Get all logged work entries for a work item' })
  @ApiParam({ name: 'taskId', description: 'Work item UUID or identifier' })
  async getTaskWorklogs(@Param('taskId') taskId: string) {
    return this.worklogService.getTaskWorklogs(taskId);
  }

  @Put('worklogs/:id')
  @ApiOperation({ summary: 'Update an existing worklog entry' })
  @ApiParam({ name: 'id', description: 'Worklog entry UUID' })
  async updateWorklog(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
    @Body() updateWorklogDto: UpdateWorklogDto,
  ) {
    const isAdmin = user?.role === 'admin' || user?.role === 'owner';
    return this.worklogService.updateWorklog(id, userId, updateWorklogDto, isAdmin);
  }

  @Delete('worklogs/:id')
  @ApiOperation({ summary: 'Delete a worklog entry and deduct logged hours' })
  @ApiParam({ name: 'id', description: 'Worklog entry UUID' })
  async deleteWorklog(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
  ) {
    const isAdmin = user?.role === 'admin' || user?.role === 'owner';
    return this.worklogService.deleteWorklog(id, userId, isAdmin);
  }

  @Get('projects/:projectId/worklogs')
  @ApiOperation({ summary: 'Get project-wide timesheet and logged hours report' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  async getProjectTimesheet(
    @Param('projectId') projectId: string,
    @Query() queryWorklogDto: QueryWorklogDto,
  ) {
    return this.worklogService.getProjectTimesheet(projectId, queryWorklogDto);
  }

  @Get('workspaces/:workspaceId/worklogs')
  @ApiOperation({ summary: 'Get workspace-wide timesheet and logged hours report' })
  @ApiParam({ name: 'workspaceId', description: 'Workspace UUID or slug' })
  async getWorkspaceTimesheet(
    @Param('workspaceId') workspaceId: string,
    @Query() queryWorklogDto: QueryWorklogDto,
  ) {
    return this.worklogService.getWorkspaceTimesheet(workspaceId, queryWorklogDto);
  }
}
