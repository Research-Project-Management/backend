import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { InvitationService } from './invitation.service';
import { CreateProjectInvitationDto } from './dto/create-invitation.dto';
import { JoinByCodeDto } from './dto/join-by-code.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import type { AuthenticatedUser } from '@/modules/iam/core/types/iam.type';

@ApiTags('Project Invitations')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/projects',
  'api/v1/project',
  'api/projects',
  'api/project',
])
@UseGuards(JwtAuthGuard)
export class InvitationController {
  constructor(private readonly invitationService: InvitationService) {}

  // ─── 1. Incoming Invitations (For Current User) ───────────────────────────

  @Get('invitations/me')
  @ApiOperation({
    summary: 'Get all pending invitations received by current user',
    description:
      'Returns list of projects where other users invited the current user to join.',
  })
  @ApiResponse({ status: 200, description: 'List of received invitations' })
  async getMyInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.invitationService.getMyInvitations(user);
  }

  @Post('invitations/:invitationId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a project invitation' })
  @ApiResponse({
    status: 200,
    description: 'Invitation accepted and joined project',
  })
  async acceptInvitation(
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitationService.acceptInvitation(invitationId, user);
  }

  @Post('invitations/:invitationId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a project invitation' })
  @ApiResponse({ status: 200, description: 'Invitation declined' })
  async declineInvitation(
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitationService.declineInvitation(invitationId, user);
  }

  @Post('invitations/join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Join a project using an invite code, token, or identifier',
  })
  @ApiResponse({ status: 200, description: 'Joined project successfully' })
  async joinByCode(
    @Body() dto: JoinByCodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitationService.joinByCode(dto.code, user);
  }

  // ─── 2. Project-level Invitations (Manage by Owner) ─────────────────────────

  @Get(':projectId/invitations')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'List all invitations for a specific project' })
  @ApiResponse({ status: 200, description: 'Project invitations list' })
  async getProjectInvitations(@Param('projectId') projectId: string) {
    return this.invitationService.getProjectInvitations(projectId);
  }

  @Post(':projectId/invitations')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Invite a user to a project via email' })
  @ApiResponse({ status: 201, description: 'Invitation sent successfully' })
  async createInvitation(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectInvitationDto,
    @CurrentUser('id') inviterId: string,
  ) {
    return this.invitationService.createInvitation(projectId, dto, inviterId);
  }

  @Delete(':projectId/invitations/:invitationId')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Revoke a project invitation' })
  @ApiResponse({ status: 200, description: 'Invitation revoked' })
  async revokeInvitation(
    @Param('projectId') projectId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitationService.revokeInvitation(projectId, invitationId);
  }
}
