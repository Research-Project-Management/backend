import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  IYourWorkRepository,
  ProjectMinimal,
  UserWorkItem,
  UserProfileData,
  UserMinimal,
} from './types/your-work.types';

const USER_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

function mapUserMinimal(user: {
  id: string;
  email: string | null;
  profile?: { name: string; avatar: string | null } | null;
} | null): UserMinimal | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? null,
    avatar: user.profile?.avatar ?? null,
  };
}

@Injectable()
export class YourWorkRepository implements IYourWorkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserWorkItems(
    projectId: string | undefined,
    userId: string,
  ): Promise<UserWorkItem[]> {
    const projectFilter = projectId
      ? { id: projectId, deletedAt: null }
      : { members: { some: { userId } }, deletedAt: null };

    const items = await this.prisma.workItem.findMany({
      where: {
        project: projectFilter,
        deletedAt: null,
        OR: [
          { assigneeId: userId },
          { authorId: userId },
          { comments: { some: { authorId: userId } } },
          { assigneeIds: { array_contains: userId } },
          { subscriberIds: { array_contains: userId } },
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
            states: true,
          },
        },
        comments: { select: { id: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return items.map((item) => ({
      ...item,
      author: mapUserMinimal(item.author)!,
      assignee: mapUserMinimal(item.assignee),
    }));
  }

  async findUserProfile(userId: string): Promise<UserProfileData | null> {
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        createdAt: true,
        profile: {
          select: {
            name: true,
            avatar: true,
          },
        },
      },
    });

    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.profile?.name ?? null,
      avatar: user.profile?.avatar ?? null,
      createdAt: user.createdAt,
    };
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
        states: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
