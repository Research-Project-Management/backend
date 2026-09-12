import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { LibraryService } from './library.service';
import {
  LibraryStatsResponseDto,
  LibraryOverviewResponseDto,
} from './dto/library.dto';
import { JwtAuthGuard } from '../../iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../iam/authz/decorators/role.decorator';
import { CurrentUser } from '../../iam/authn/decorators/user.decorator';

@ApiTags('Library Core')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get([
    'projects/:projectId/library/stats',
    'project/:projectId/library/stats',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get project library statistics' })
  async getProjectStats(
    @Param('projectId') projectId: string,
  ): Promise<LibraryStatsResponseDto> {
    return this.libraryService.getLibraryStats(projectId);
  }

  @Get([
    'projects/:projectId/library/overview',
    'project/:projectId/library/overview',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'Get project library overview' })
  async getProjectOverview(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId?: string,
  ): Promise<LibraryOverviewResponseDto> {
    return this.libraryService.getLibraryOverview(projectId, userId);
  }

  @Get('me/library/overview')
  @ApiOperation({ summary: 'Get personal user library overview' })
  async getUserOverview(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ): Promise<LibraryOverviewResponseDto> {
    if (projectId) {
      return this.libraryService.getLibraryOverview(projectId, userId);
    }
    return this.libraryService.getUserOverview(userId);
  }
}
