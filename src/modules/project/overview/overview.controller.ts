import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { OverviewService } from './overview.service';

@ApiTags('Project Overview')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get(':projectId/overview')
  @ApiOperation({
    summary: 'Get comprehensive overview dashboard for a project',
  })
  @ApiResponse({
    status: 200,
    description:
      'Aggregated project metadata, metrics, links, cycle and activities',
  })
  getProjectOverview(@Param('projectId') projectId: string) {
    return this.overviewService.getProjectOverview(projectId);
  }
}
