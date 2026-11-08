import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { YourWorkService } from './your-work.service';
import { YourWorkSummaryDto } from './dto/your-work.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { normalizeYourWorkScopeProjectId } from './domain/your-work.domain';

@ApiTags('Your Work')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/analytics', 'api/analytics'])
@UseGuards(JwtAuthGuard)
export class YourWorkController {
  constructor(private readonly yourWorkService: YourWorkService) {}

  @Get([
    'your-work',
    'projects/:projectId/your-work',
    'project/:projectId/your-work',
  ])
  @ApiOperation({
    summary: 'Get user summary workload and metrics across projects',
  })
  @ApiParam({
    name: 'projectId',
    required: false,
    description: 'Optional project UUID to scope workload',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns workload work items, activity feed, and recent items for user',
    type: YourWorkSummaryDto,
  })
  async getYourWork(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
    @Query('projectId') queryProjectId?: string,
  ): Promise<YourWorkSummaryDto> {
    const targetProjectId = normalizeYourWorkScopeProjectId(
      projectId || queryProjectId,
      userId,
    );
    return this.yourWorkService.getYourWork(targetProjectId, userId);
  }
}
