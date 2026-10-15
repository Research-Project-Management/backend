import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, WorkItemLabel as Label } from '@prisma/client';
import { LabelWithChildren, ReorderLabelItem } from './types/label.types';

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectLabels(
    projectId: string,
    type?: string,
  ): Promise<LabelWithChildren[]> {
    const normalizedType = type?.trim().toLowerCase();
    return this.prisma.workItemLabel.findMany({
      where: {
        projectId,
        ...(normalizedType === 'root' || normalizedType === 'parent'
          ? { parentId: null }
          : normalizedType === 'sub' || normalizedType === 'child'
            ? { parentId: { not: null } }
            : {}),
      },
      include: {
        children: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findUserLabels(
    userId: string,
    type?: string,
    projectId?: string | null,
  ): Promise<Label[]> {
    const normalizedType = type?.trim().toLowerCase();
    return this.prisma.workItemLabel.findMany({
      where: {
        createdById: userId,
        ...(projectId !== undefined && { projectId }),
        ...(normalizedType === 'root' || normalizedType === 'parent'
          ? { parentId: null }
          : normalizedType === 'sub' || normalizedType === 'child'
            ? { parentId: { not: null } }
            : {}),
      },
      include: {
        children: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(labelId: string): Promise<LabelWithChildren | null> {
    return this.prisma.workItemLabel.findUnique({
      where: { id: labelId },
      include: {
        children: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
        parent: true,
      },
    });
  }

  async findByNameInProject(
    projectId: string,
    name: string,
    excludeId?: string,
  ): Promise<Label | null> {
    return this.prisma.workItemLabel.findFirst({
      where: {
        projectId,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
  }

  async findProject(projectId: string): Promise<{ id: string } | null> {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
  }

  async getLastSortOrder(
    projectId: string,
    parentId?: string | null,
  ): Promise<number | null> {
    const lastLabel = await this.prisma.workItemLabel.findFirst({
      where: {
        projectId,
        parentId: parentId || null,
      },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return lastLabel?.sortOrder ?? null;
  }

  async findDuplicate(params: {
    projectId: string | null;
    name: string;
    parentId?: string | null;
    excludeId?: string;
    createdById?: string;
  }): Promise<Label | null> {
    return this.prisma.workItemLabel.findFirst({
      where: {
        ...(params.excludeId && { id: { not: params.excludeId } }),
        ...(params.createdById && { createdById: params.createdById }),
        projectId: params.projectId,
        name: { equals: params.name.trim(), mode: 'insensitive' },
        parentId: params.parentId ?? null,
      },
    });
  }

  async create(data: Prisma.WorkItemLabelUncheckedCreateInput): Promise<Label> {
    return this.prisma.workItemLabel.create({
      data,
    });
  }

  async update(
    labelId: string,
    data: Prisma.WorkItemLabelUncheckedUpdateInput,
  ): Promise<Label> {
    return this.prisma.workItemLabel.update({
      where: { id: labelId },
      data,
    });
  }

  async delete(labelId: string): Promise<Label> {
    return this.prisma.workItemLabel.delete({
      where: { id: labelId },
    });
  }

  async reorder(projectId: string, updates: ReorderLabelItem[]): Promise<void> {
    await this.prisma.$transaction(
      updates.map((item) =>
        this.prisma.workItemLabel.updateMany({
          where: { id: item.id, projectId },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );
  }

  async detachMultipleFromWorkItems(
    projectId: string,
    labelIds: string[],
    labelNames?: string[],
  ): Promise<number> {
    const targets = Array.from(
      new Set([...labelIds, ...(labelNames || [])].filter(Boolean)),
    );
    if (!targets.length) return 0;

    try {
      const workItems = await this.prisma.workItem.findMany({
        where: {
          projectId,
          labels: { hasSome: targets },
        },
        select: { id: true, labels: true },
      });

      if (!workItems.length) return 0;

      const targetSet = new Set(targets);
      await this.prisma.$transaction(
        workItems.map((item) => {
          const cleaned = item.labels.filter(
            (label: string) => !targetSet.has(label),
          );
          return this.prisma.workItem.update({
            where: { id: item.id },
            data: { labels: cleaned },
          });
        }),
      );

      return workItems.length;
    } catch {
      return 0;
    }
  }
}
