import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { InvitationRepository } from './invitation.repository';
import { CreateProjectInvitationDto } from './dto/create-invitation.dto';
import { ProjectMemberRole, InvitationStatus } from '@prisma/client';
import type { AuthenticatedUser } from '@/modules/iam/core/types/iam.type';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CACHE_KEYS } from '../core/constants/cache.constant';
import { IAM_REDIS_KEYS } from '@/modules/iam/core/constants/redis.constant';

@Injectable()
export class InvitationService {
  constructor(
    private readonly repository: InvitationRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * Invalidates Redis caches for project and member when membership changes.
   */
  private async invalidateInvitationCaches(
    projectId: string,
    userId: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await Promise.all([
        this.cache.del(IAM_REDIS_KEYS.role(projectId, userId)),
        this.cache.del(IAM_REDIS_KEYS.permissions(projectId, userId)),
        this.cache.del(CACHE_KEYS.detail(projectId)),
        this.cache.del(CACHE_KEYS.overview(projectId)),
        this.cache.del(CACHE_KEYS.userProjects(userId)),
      ]);
    } catch {
      // Best effort cache invalidation
    }
  }

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

    // SSOT: Invalidate Redis caches so caller immediately sees their new permissions and project list
    await this.invalidateInvitationCaches(invitation.projectId, user.id);

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
   * Enforces Zero-Trust: Private projects strictly require an authentic invitation token.
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

    // 2. Try finding project by identifier (e.g. "BIO", "DLGA") or ID
    const project = await this.repository.findProjectByIdOrIdentifier(trimmed);
    if (!project) {
      throw new NotFoundException('Project or invite code not found');
    }

    // Check if user is already a member
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

    // Anti-BOLA / Zero-Trust Security Invariant:
    // Only projects explicitly configured with public network allow open joining without an invitation
    if (project.network !== 'public') {
      throw new ForbiddenException(
        'This project is private and requires a valid invitation token to join',
      );
    }

    const role = ProjectMemberRole.contributor;
    await this.repository.addProjectMember(project.id, user.id, role);
    await this.invalidateInvitationCaches(project.id, user.id);

    return {
      message: 'Joined project successfully',
      projectId: project.id,
      project,
    };
  }

  /**
   * Create an invitation for a specific project.
   * Enforces SSOT invariants:
   * 1. Cannot invite with owner role (ownership is via creation or transfer only).
   * 2. Cannot send invites for archived/deleted projects.
   * 3. Cannot invite self.
   * 4. Cannot invite a user who is already a member of the project.
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

    if ((project as any).isActive === false) {
      throw new BadRequestException(
        'Cannot send invitations for an archived or inactive project',
      );
    }

    // Zero-Trust: Prevent assigning owner role via invitation
    if (dto.role === ProjectMemberRole.owner) {
      throw new ForbiddenException(
        'Cannot invite a member with owner role. Use transfer ownership instead.',
      );
    }

    const email = dto.email.trim().toLowerCase();

    // Prevent self-invitation
    const targetUser = await this.repository.findUserById(inviterId);
    if (
      targetUser &&
      targetUser.email &&
      targetUser.email.toLowerCase() === email
    ) {
      throw new BadRequestException('You cannot invite yourself');
    }

    // Prevent inviting someone who is already a member of this project
    const existingUser = await this.repository.findUserByEmail(email);
    if (existingUser) {
      const isMember = await this.repository.findMember(
        project.id,
        existingUser.id,
      );
      if (isMember) {
        throw new BadRequestException(
          'User is already a member of this project',
        );
      }
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

    // Generate cryptographically secure token
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
