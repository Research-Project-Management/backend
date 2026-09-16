import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { ProjectAnalyticsService } from './analytics.service';

@ApiTags('Project Analytics & Portfolio')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/projects')
export class ProjectAnalyticsController {
  constructor(private readonly analyticsService: ProjectAnalyticsService) {}


  @Get(':projectId/analytics')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get detailed dimensional breakdown for a project' })
  getAnalytics(@Param('projectId') projectId: string) {
    return this.analyticsService.getProjectDetailedBreakdown(projectId);
  }
}
