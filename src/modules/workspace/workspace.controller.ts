import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { WorkspaceService } from './workspace.service';
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  AddWorkspaceMemberDto,
  UpdateWorkspaceMemberDto,
  JoinWorkspaceDto,
} from './dto/workspace.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authz';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('api/workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get()
  @ApiOperation({ summary: 'List workspaces for current user' })
  async getMyWorkspaces(@CurrentUser('id') userId: string) {
    return this.workspaceService.getMyWorkspaces(userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new workspace' })
  async createWorkspace(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspaceService.createWorkspace(userId, dto);
  }

  @Post('join/code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a workspace via invite code' })
  async joinWorkspace(
    @CurrentUser('id') userId: string,
    @Body() dto: JoinWorkspaceDto,
  ) {
    return this.workspaceService.joinByCode(userId, dto.inviteCode);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get workspace details by ID or slug' })
  async getWorkspace(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.getWorkspace(workspaceId, userId);
  }

  @Put(':workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Update workspace settings' })
  async updateWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaceService.updateWorkspace(workspaceId, dto);
  }

  @Delete(':workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner')
  @ApiOperation({ summary: 'Delete a workspace permanently' })
  async deleteWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.deleteWorkspace(workspaceId);
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'List all workspace members' })
  async getMembers(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.getMembers(workspaceId);
  }

  @Post(':workspaceId/members')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Add a member to the workspace' })
  async addMember(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
  ) {
    return this.workspaceService.addMember(workspaceId, dto);
  }

  @Put(':workspaceId/members/:userId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Update workspace member role' })
  async updateMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateWorkspaceMemberDto,
  ) {
    return this.workspaceService.updateMember(workspaceId, userId, dto);
  }

  @Delete(':workspaceId/members/:userId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Remove a member from the workspace' })
  async removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    return this.workspaceService.removeMember(workspaceId, userId);
  }

  @Post(':workspaceId/leave')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Leave a workspace' })
  async leaveWorkspace(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.leaveWorkspace(workspaceId, userId);
  }

  @Get([':workspaceId/search', '/api/search/workspaces/:workspaceId'])
  @ApiOperation({ summary: 'Global search across workspace entities' })
  async searchWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Query('q') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.search(workspaceId, query || '', userId);
  }

  @Get('/api/search')
  @ApiOperation({ summary: 'Global search via workspace query param' })
  async searchGlobal(
    @Query('workspaceId') workspaceId: string,
    @Query('q') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.search(workspaceId || '', query || '', userId);
  }
}
