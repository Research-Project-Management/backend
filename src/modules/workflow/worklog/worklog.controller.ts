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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { WorklogService } from './worklog.service';
import {
  CreateWorklogDto,
  UpdateWorklogDto,
  QueryWorklogDto,
} from './dto/worklog.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';

@ApiTags('Workflow - Worklogs')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class WorklogController {
  constructor(private readonly worklogService: WorklogService) {}

  @Get('project/:projectId/worklogs')
  @ApiOperation({
    summary: 'Get project worklogs with filtering and pagination',
  })
  async getProjectWorklogs(
    @Param('projectId') projectId: string,
    @Query() query: QueryWorklogDto,
  ) {
    return this.worklogService.getProjectWorklogs(projectId, query);
  }

  @Post('project/:projectId/worklogs')
  @ApiOperation({ summary: 'Log work hours for a project / task' })
  async createWorklog(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorklogDto,
  ) {
    return this.worklogService.createWorklog(projectId, userId, dto);
  }

  @Get('workspace/:workspaceId/worklogs')
  @ApiOperation({ summary: 'Get workspace consolidated worklogs' })
  async getWorkspaceWorklogs(
    @Param('workspaceId') workspaceId: string,
    @Query() query: QueryWorklogDto,
  ) {
    return this.worklogService.getWorkspaceWorklogs(workspaceId, query);
  }

  @Delete('worklogs/:id')
  @ApiOperation({ summary: 'Delete a worklog entry' })
  async deleteWorklog(@Param('id') id: string) {
    return this.worklogService.deleteWorklog(id);
  }

  @Put('worklogs/:id')
  @ApiOperation({ summary: 'Update a worklog entry (hours, description, date)' })
  async updateWorklog(
    @Param('id') id: string,
    @Body() dto: UpdateWorklogDto,
  ) {
    return this.worklogService.updateWorklog(id, dto);
  }
}
