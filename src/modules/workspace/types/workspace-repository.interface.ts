/**
 * Workspace Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import {
  Workspace,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceInvitation,
  InvitationStatus,
  Prisma,
} from '@prisma/client';

export type WorkspaceWithMembers = Prisma.WorkspaceGetPayload<{
  include: {
    members: {
      include: {
        user: {
          select: {
            id: true;
            name: true;
            email: true;
            avatar: true;
          };
        };
      };
    };
  };
}>;

export interface IWorkspaceRepository {
  findUserWorkspaces(userId: string): Promise<WorkspaceWithMembers[]>;
  findById(id: string): Promise<WorkspaceWithMembers | null>;
  findBySlug(slug: string): Promise<WorkspaceWithMembers | null>;
  findByIdOrSlug(idOrSlug: string): Promise<WorkspaceWithMembers | null>;
  findByInviteCode(inviteCode: string): Promise<Workspace | null>;

  createWorkspace(
    data: Prisma.WorkspaceCreateInput | Prisma.WorkspaceUncheckedCreateInput,
  ): Promise<WorkspaceWithMembers>;

  updateWorkspace(
    id: string,
    data: Prisma.WorkspaceUpdateInput | Prisma.WorkspaceUncheckedUpdateInput,
  ): Promise<WorkspaceWithMembers>;

  softDeleteWorkspace(id: string): Promise<Workspace>;
  restoreWorkspace(id: string): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<Workspace>;

  // Membership operations
  findMembers(
    workspaceId: string,
    pagination?: { skip?: number; take?: number },
  ): Promise<WorkspaceMember[]>;
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMember | null>;
  createMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMember>;
  updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMember>;
  deleteMember(workspaceId: string, userId: string): Promise<void>;
  countOwners(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number>;
  findUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string | null } | null>;
  withTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface IWorkspaceInvitationRepository {
  createInvitation(data: {
    workspaceId: string;
    email: string;
    role: WorkspaceMemberRole;
    invitedById: string;
    expiresInDays?: number;
  }): Promise<WorkspaceInvitation>;

  findByToken(token: string): Promise<{
    id: string;
    workspaceId: string;
    email: string;
    role: WorkspaceMemberRole;
    token: string;
    status: InvitationStatus;
    expiresAt: Date;
    workspace: { id: string; name: string; url: string };
    invitedBy: {
      id: string;
      name: string;
      email: string | null;
      avatar: string | null;
    };
  } | null>;

  updateStatus(
    id: string,
    status: InvitationStatus,
    acceptedAt?: Date,
  ): Promise<WorkspaceInvitation>;
  listPendingByWorkspace(workspaceId: string): Promise<WorkspaceInvitation[]>;
  revokeInvitation(id: string): Promise<WorkspaceInvitation>;
}
