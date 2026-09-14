import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { InvitationRepository } from './invitation.repository';
import { CreateProjectInvitationDto } from './dto/create-invitation.dto';
import { ProjectMemberRole, InvitationStatus } from '@prisma/client';
import type { AuthenticatedUser } from '@/modules/iam/core/types/iam.type';

@Injectable()
export class InvitationService {
  constructor(private readonly repository: InvitationRepository) {}

  /**
   * Helper to hash an invitation raw token using sha256.
   */
  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Get all incoming project invitations for the current logged in user.
   * ("người khác mời tôi vào project của họ")
   */
  async getMyInvitations(user: AuthenticatedUser) {
    if (!user || !user.email) {
      return [];
    }

    const invitations = await this.repository.findPendingByEmail(user.email);
    const inviterIds = Array.from(
      new Set(invitations.map((inv) => inv.invitedById)),
    );
    const inviters = await this.repository.findUsersByIds(inviterIds);
    const inviterMap = new Map(inviters.map((u) => [u.id, u]));

    return invitations.map((inv) => ({
      ...inv,
      inviter: inviterMap.get(inv.invitedById) || null,
    }));
  }

  /**
   * Accept an invitation to join a project.
   */
  async acceptInvitation(invitationId: string, user: AuthenticatedUser) {
    const invitation = await this.repository.findById(invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== InvitationStatus.pending) {
      throw new BadRequestException(
        `Invitation is already ${invitation.status}`,
      );
    }

    if (new Date() > invitation.expiresAt) {
      await this.repository.updateStatus(
        invitation.id,
        InvitationStatus.expired,
      );
      throw new BadRequestException('Invitation has expired');
    }

    // Verify email match (case-insensitive)
    if (
      user.email &&
      invitation.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new ForbiddenException(
        'This invitation was sent to a different email address',
      );
    }

    // Check if already a member
    const existingMember = await this.repository.findMember(
      invitation.projectId,
      user.id,
    );

    if (!existingMember) {
      await this.repository.addProjectMember(
        invitation.projectId,
        user.id,
        invitation.role,
      );
    }

    await this.repository.updateStatus(
      invitation.id,
      InvitationStatus.accepted,
    );

    return {
      message: 'Successfully joined project',
      projectId: invitation.projectId,
      project: invitation.project,
    };
  }

  /**
   * Decline an invitation to join a project.
   */
  async declineInvitation(invitationId: string, user: AuthenticatedUser) {
    const invitation = await this.repository.findById(invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (
      user.email &&
      invitation.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new ForbiddenException('You cannot decline this invitation');
    }

    await this.repository.updateStatus(
      invitation.id,
      InvitationStatus.declined,
    );

    return {
      message: 'Invitation declined',
    };
  }

  /**
   * Join a project using an invite code (project identifier, token, or tokenHash).
   */
  async joinByCode(code: string, user: AuthenticatedUser) {
    const trimmed = code.trim();
    if (!trimmed) {
      throw new BadRequestException('Join code cannot be empty');
    }

    // 1. Try finding by raw token or token hash
    const hashed = this.hashToken(trimmed);
    let invitation = await this.repository.findByTokenHash(trimmed);
    if (!invitation) {
      invitation = await this.repository.findByTokenHash(hashed);
    }

    if (invitation) {
      return this.acceptInvitation(invitation.id, user);
    }

    // 2. Try finding project by identifier (e.g. "TIEPTUC", "TT2") or ID
    const project = await this.repository.findProjectByIdOrIdentifier(trimmed);
    if (!project) {
      throw new NotFoundException('Project or invite code not found');
    }

    // Check if user already a member
    const existing = await this.repository.findMember(project.id, user.id);
    if (existing) {
      return {
        message: 'You are already a member of this project',
        projectId: project.id,
        project,
      };
    }

    // Check if there is a pending invite for this user on this project
    const pendingInvite = await this.repository.findPendingByProjectAndEmail(
      project.id,
      user.email,
    );

    if (pendingInvite) {
      return this.acceptInvitation(pendingInvite.id, user);
    }

    // If project network is public or accessible
    const role = ProjectMemberRole.contributor;
    await this.repository.addProjectMember(project.id, user.id, role);

    return {
      message: 'Joined project successfully',
      projectId: project.id,
      project,
    };
  }

  /**
   * Create an invitation for a specific project.
   */
  async createInvitation(
    projectId: string,
    dto: CreateProjectInvitationDto,
    inviterId: string,
  ) {
    const project =
      await this.repository.findProjectByIdOrIdentifier(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const email = dto.email.trim().toLowerCase();

    // Check if user already exists and is already a member
    const targetUser = await this.repository.findUserById(inviterId);
    if (
      targetUser &&
      targetUser.email &&
      targetUser.email.toLowerCase() === email
    ) {
      throw new BadRequestException('You cannot invite yourself');
    }

    // Check if duplicate pending invite exists
    const existingInvite = await this.repository.findPendingByProjectAndEmail(
      projectId,
      email,
    );

    if (existingInvite) {
      throw new BadRequestException(
        `A pending invitation has already been sent to ${email}`,
      );
    }

    // Generate token
    const rawToken = randomBytes(24).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invitation = await this.repository.create({
      projectId,
      email,
      role: dto.role || ProjectMemberRole.contributor,
      tokenHash,
      invitedById: inviterId,
      expiresAt,
    });

    return {
      message: 'Invitation sent successfully',
      invitation,
      token: rawToken,
    };
  }

  /**
   * Get all invitations for a project (Owner / Admin view).
   */
  async getProjectInvitations(projectId: string) {
    const invitations = await this.repository.findByProjectId(projectId);
    const inviterIds = Array.from(
      new Set(invitations.map((inv) => inv.invitedById)),
    );
    const inviters = await this.repository.findUsersByIds(inviterIds);
    const inviterMap = new Map(inviters.map((u) => [u.id, u]));

    return invitations.map((inv) => ({
      ...inv,
      inviter: inviterMap.get(inv.invitedById) || null,
    }));
  }

  /**
   * Revoke an invitation.
   */
  async revokeInvitation(projectId: string, invitationId: string) {
    const invitation = await this.repository.findById(invitationId);
    if (!invitation || invitation.projectId !== projectId) {
      throw new NotFoundException('Invitation not found in this project');
    }

    await this.repository.updateStatus(invitationId, InvitationStatus.revoked);

    return {
      message: 'Invitation revoked successfully',
    };
  }
}
