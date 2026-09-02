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
  CreateWorkspaceInvitationDto,
} from './dto/workspace.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller(['api/workspace', 'api/workspaces'])
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
  @ApiOperation({ summary: 'Delete (soft-delete) a workspace' })
  async deleteWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.deleteWorkspace(workspaceId);
  }

  @Post(':workspaceId/restore')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner')
  @ApiOperation({ summary: 'Restore a soft-deleted workspace' })
  async restoreWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.restoreWorkspace(workspaceId);
  }

  // ── Member Management ──────────────────────────────────────────────────────

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

  // ── Invitations Management ─────────────────────────────────────────────────

  @Post(':workspaceId/invitations')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Create and send a workspace invitation' })
  async createInvitation(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') invitedById: string,
    @Body() dto: CreateWorkspaceInvitationDto,
  ) {
    return this.workspaceService.createInvitation(
      workspaceId,
      invitedById,
      dto,
    );
  }

  @Get(':workspaceId/invitations')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'List pending invitations for a workspace' })
  async listPendingInvitations(@Param('workspaceId') workspaceId: string) {
    return this.workspaceService.listPendingInvitations(workspaceId);
  }

  @Get(['invitations/token/:token', 'invitations/:token'])
  @ApiOperation({ summary: 'Get invitation details by token' })
  async getInvitationByToken(@Param('token') token: string) {
    return this.workspaceService.getInvitationByToken(token);
  }

  @Post(['invitations/token/:token/accept', 'invitations/:token/accept'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a workspace invitation by token' })
  async acceptInvitation(
    @Param('token') token: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.acceptInvitation(userId, token);
  }

  @Post(['invitations/token/:token/decline', 'invitations/:token/decline'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a workspace invitation by token' })
  async declineInvitation(@Param('token') token: string) {
    return this.workspaceService.declineInvitation(token);
  }

  @Delete(':workspaceId/invitations/:invitationId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Revoke a pending workspace invitation' })
  async revokeInvitation(
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.workspaceService.revokeInvitation(workspaceId, invitationId);
  }

  // ── Global Search ──────────────────────────────────────────────────────────

  @Get([':workspaceId/search', 'search/:workspaceId'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Global search across workspace entities' })
  async searchWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Query('q') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.search(workspaceId, query || '', userId);
  }

  @Get('search')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Global search via workspace query param' })
  async searchGlobal(
    @Query('workspaceId') workspaceId: string,
    @Query('q') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.workspaceService.search(workspaceId || '', query || '', userId);
  }
}
