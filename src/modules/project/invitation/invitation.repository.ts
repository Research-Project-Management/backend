import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectMemberRole, InvitationStatus, Prisma } from '@prisma/client';
import { isUuid } from '@/core/utils/uuid.util';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

const PROJECT_SELECT = {
  id: true,
  name: true,
  identifier: true,
  avatar: true,
  description: true,
  network: true,
  isActive: true,
} as const;

@Injectable()
export class InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find all active/pending invitations for a given user email.
   */
  async findPendingByEmail(email: string) {
    const normalizedEmail = email.trim().toLowerCase();

    return this.prisma.projectInvitation.findMany({
      where: {
        email: { equals: normalizedEmail, mode: 'insensitive' },
        status: InvitationStatus.pending,
        expiresAt: { gt: new Date() },
      },
      include: {
        project: { select: PROJECT_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find invitation by primary key ID.
   */
  async findById(id: string) {
    if (!isUuid(id)) return null;

    return this.prisma.projectInvitation.findUnique({
      where: { id },
      include: {
        project: { select: PROJECT_SELECT },
      },
    });
  }

  /**
   * Find invitation by token hash.
   */
  async findByTokenHash(tokenHash: string) {
    return this.prisma.projectInvitation.findUnique({
      where: { tokenHash },
      include: {
        project: { select: PROJECT_SELECT },
      },
    });
  }

  /**
   * Find pending invitation for a specific project & email.
   */
  async findPendingByProjectAndEmail(projectId: string, email: string) {
    if (!isUuid(projectId)) return null;
    const normalizedEmail = email.trim().toLowerCase();

    return this.prisma.projectInvitation.findFirst({
      where: {
        projectId,
        email: { equals: normalizedEmail, mode: 'insensitive' },
        status: InvitationStatus.pending,
        expiresAt: { gt: new Date() },
      },
      include: {
        project: { select: PROJECT_SELECT },
      },
    });
  }

  /**
   * Find all invitations belonging to a project.
   */
  async findByProjectId(projectId: string) {
    if (!isUuid(projectId)) return [];

    return this.prisma.projectInvitation.findMany({
      where: { projectId },
      include: {
        project: { select: PROJECT_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Create a new project invitation.
   */
  async create(data: {
    projectId: string;
    email: string;
    role: ProjectMemberRole;
    tokenHash: string;
    invitedById: string;
    expiresAt: Date;
  }) {
    return this.prisma.projectInvitation.create({
      data: {
        projectId: data.projectId,
        email: data.email.trim().toLowerCase(),
        role: data.role,
        tokenHash: data.tokenHash,
        invitedById: data.invitedById,
        status: InvitationStatus.pending,
        expiresAt: data.expiresAt,
      },
      include: {
        project: { select: PROJECT_SELECT },
      },
    });
  }

  /**
   * Update invitation status.
   */
  async updateStatus(id: string, status: InvitationStatus) {
    if (!isUuid(id)) return null;

    return this.prisma.projectInvitation.update({
      where: { id },
      data: { status },
      include: {
        project: { select: PROJECT_SELECT },
      },
    });
  }

  /**
   * Delete an invitation.
   */
  async delete(id: string) {
    if (!isUuid(id)) return null;

    return this.prisma.projectInvitation.delete({
      where: { id },
    });
  }

  /**
   * Fetch inviter user profile by ID.
   */
  async findUserById(userId: string) {
    if (!isUuid(userId)) return null;

    return this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
  }

  /**
   * Fetch user profile by email (case-insensitive).
   */
  async findUserByEmail(email: string) {
    if (!email) return null;
    const normalizedEmail = email.trim().toLowerCase();

    return this.prisma.user.findFirst({
      where: {
        email: { equals: normalizedEmail, mode: 'insensitive' },
        deletedAt: null,
      },
      select: USER_SELECT,
    });
  }

  /**
   * Fetch multiple users by IDs.
   */
  async findUsersByIds(userIds: string[]) {
    const validIds = userIds.filter(isUuid);
    if (validIds.length === 0) return [];

    return this.prisma.user.findMany({
      where: { id: { in: validIds } },
      select: USER_SELECT,
    });
  }

  /**
   * Find project by ID or unique identifier.
   */
  async findProjectByIdOrIdentifier(idOrIdentifier: string) {
    const normalized = idOrIdentifier.trim();

    if (isUuid(normalized)) {
      return this.prisma.project.findFirst({
        where: { id: normalized, deletedAt: null },
        select: PROJECT_SELECT,
      });
    }

    return this.prisma.project.findFirst({
      where: {
        identifier: { equals: normalized, mode: 'insensitive' },
        deletedAt: null,
      },
      select: PROJECT_SELECT,
    });
  }

  /**
   * Check if a user is already a member of a project.
   */
  async findMember(projectId: string, userId: string) {
    if (!isUuid(projectId) || !isUuid(userId)) return null;

    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
  }

  /**
   * Add a member to a project.
   */
  async addProjectMember(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ) {
    return this.prisma.projectMember.create({
      data: {
        projectId,
        userId,
        role,
      },
    });
  }
}
