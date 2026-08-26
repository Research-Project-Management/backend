import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  WorkspaceMemberRole,
  InvitationStatus,
  WorkspaceInvitation,
} from '@prisma/client';
import { IWorkspaceInvitationRepository } from './types/workspace-repository.interface';
import * as crypto from 'crypto';

@Injectable()
export class WorkspaceInvitationRepository implements IWorkspaceInvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createInvitation(data: {
    workspaceId: string;
    email: string;
    role: WorkspaceMemberRole;
    invitedById: string;
    expiresInDays?: number;
  }): Promise<WorkspaceInvitation> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays ?? 7));

    return this.prisma.workspaceInvitation.create({
      data: {
        workspaceId: data.workspaceId,
        email: data.email.toLowerCase(),
        role: data.role,
        token,
        invitedById: data.invitedById,
        status: 'pending',
        expiresAt,
      },
    });
  }

  async findByToken(token: string) {
    return this.prisma.workspaceInvitation.findUnique({
      where: { token },
      include: {
        workspace: {
          select: { id: true, name: true, url: true },
        },
        invitedBy: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    });
  }

  async updateStatus(id: string, status: InvitationStatus, acceptedAt?: Date) {
    return this.prisma.workspaceInvitation.update({
      where: { id },
      data: {
        status,
        acceptedAt: acceptedAt ?? (status === 'accepted' ? new Date() : null),
      },
    });
  }

  async listPendingByWorkspace(workspaceId: string) {
    return this.prisma.workspaceInvitation.findMany({
      where: {
        workspaceId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeInvitation(id: string) {
    return this.updateStatus(id, 'revoked');
  }
}
