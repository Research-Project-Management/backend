import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectWithMembers } from '../core/types/project.type';
import { isUuid } from '@/core/utils/uuid.util';
import { USER_SELECT } from '../core/core.repository';

@Injectable()
export class ArchiveRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectById(projectId: string) {
    if (!isUuid(projectId)) return null;
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, isArchived: true, name: true },
    });
  }

  async archiveProject(projectId: string): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });
  }

  async unarchiveProject(projectId: string): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        isArchived: false,
        archivedAt: null,
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });
  }

  async findArchivedProjectsByUser(userId: string): Promise<ProjectWithMembers[]> {
    if (!isUuid(userId)) return [];

    return this.prisma.project.findMany({
      where: {
        OR: [{ createdById: userId }, { members: { some: { userId } } }],
        isArchived: true,
        deletedAt: null,
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { archivedAt: 'desc' },
    });
  }
}
