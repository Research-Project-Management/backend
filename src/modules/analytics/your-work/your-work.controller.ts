import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { YourWorkService } from './your-work.service';
import { YourWorkSummaryDto } from './dto/your-work.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Your Work')
@ApiBearerAuth('JWT-auth')
@Controller('api/analytics')
@UseGuards(JwtAuthGuard)
export class YourWorkController {
  constructor(private readonly yourWorkService: YourWorkService) {}

  @Get('your-work/:workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get user summary workload and metrics' })
  @ApiResponse({
    status: 200,
    description:
      'Returns workload tasks, activity feed, and recent items for user',
    type: YourWorkSummaryDto,
  })
  async getYourWork(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ): Promise<YourWorkSummaryDto> {
    return this.yourWorkService.getYourWork(workspaceId, userId);
  }
}
