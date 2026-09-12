import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  IYourWorkRepository,
  ProjectMinimal,
  UserTaskItem,
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

  async findUserTasks(
    projectId: string | undefined,
    userId: string,
  ): Promise<UserTaskItem[]> {
    const projectFilter = projectId
      ? { id: projectId, deletedAt: null }
      : { members: { some: { userId } }, deletedAt: null };

    return this.prisma.workItem.findMany({
      where: {
        project: projectFilter,
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

  async findUserProjects(
    projectId: string | undefined,
    userId: string,
  ): Promise<ProjectMinimal[]> {
    const whereClause = projectId
      ? { id: projectId, isActive: true, deletedAt: null }
      : { members: { some: { userId } }, isActive: true, deletedAt: null };

    return this.prisma.project.findMany({
      where: whereClause,
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
