import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import {
  IYourWorkRepository,
  ProjectMinimal,
  UserWorkspaceTaskItem,
  UserProfileData,
} from './types/your-work.types';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class YourWorkRepository implements IYourWorkRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async getCanonicalWorkspaceId(
    workspaceId: string,
  ): Promise<string | null> {
    if (!workspaceId) return null;
    const ws = await this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceId),
      select: { id: true },
    });
    return ws?.id ?? (isUuid(workspaceId) ? workspaceId : null);
  }

  async findUserWorkspaceTasks(
    workspaceId: string,
    userId: string,
  ): Promise<UserWorkspaceTaskItem[]> {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];

    return this.prisma.task.findMany({
      where: {
        project: { workspaceId: canonicalId, deletedAt: null },
        deletedAt: null,
        OR: [
          { assigneeId: userId },
          { authorId: userId },
          { comments: { some: { authorId: userId } } },
        ],
      },
      include: {
        author: { select: USER_SELECT },
        assignee: { select: USER_SELECT },
        project: {
          select: {
            id: true,
            name: true,
            avatar: true,
            identifier: true,
            taskColumns: true,
          },
        },
        comments: { select: { id: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findUserProfile(userId: string): Promise<UserProfileData | null> {
    if (!userId) return null;
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        createdAt: true,
      },
    });
  }

  async findUserWorkspaceProjects(
    workspaceId: string,
    _userId: string,
  ): Promise<ProjectMinimal[]> {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) return [];

    return this.prisma.project.findMany({
      where: {
        workspaceId: canonicalId,
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        identifier: true,
        avatar: true,
        taskColumns: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
