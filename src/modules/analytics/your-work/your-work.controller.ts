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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';

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
  async getYourWork(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
    @Query('projectId') queryProjectId?: string,
  ): Promise<YourWorkSummaryDto> {
    const targetProjectId = projectId || queryProjectId;
    return this.yourWorkService.getYourWork(targetProjectId, userId);
  }
}
