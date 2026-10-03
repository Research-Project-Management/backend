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
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';

@ApiTags('Your Work')
@ApiBearerAuth('JWT-auth')
@Controller('api/analytics')
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
  @ApiResponse({
    status: 403,
    description:
      'User does not have permission to access this project workload',
  })
  @ApiResponse({
    status: 404,
    description: 'Target project not found',
  })
  async getYourWork(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Query('forceEmpty') forceEmpty?: string,
  ): Promise<YourWorkSummaryDto> {
    const targetProjectId = projectId || queryProjectId;
    const isForceEmpty = forceEmpty === 'true' || forceEmpty === '1';
    return this.yourWorkService.getYourWork(
      targetProjectId,
      userId,
      isForceEmpty,
    );
  }
}
