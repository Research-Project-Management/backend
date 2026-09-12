import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { LibraryService } from './library.service';
import {
  LibraryStatsResponseDto,
  LibraryOverviewResponseDto,
} from './dto/library.dto';
import { JwtAuthGuard } from '../../iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../iam/authz/decorators/workspace-roles.decorator';
import { CurrentUser } from '../../iam/authn/decorators/current-user.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library',
  'api/v1/workspace/:workspaceId/library',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get('stats')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getStats(
    @Param('workspaceId') workspaceId: string,
  ): Promise<LibraryStatsResponseDto> {
    return this.libraryService.getLibraryStats(workspaceId);
  }

  @Get('overview')
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getOverview(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId?: string,
  ): Promise<LibraryOverviewResponseDto> {
    return this.libraryService.getLibraryOverview(workspaceId, userId);
  }
}

export const CoreController = LibraryController;
export type CoreController = LibraryController;
