import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, WorkItemLabel as Label } from '@prisma/client';
import {
  ILabelRepository,
  LabelWithChildren,
  ReorderLabelItem,
  LabelType,
} from './types/label.types';

@Injectable()
export class LabelRepository implements ILabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectLabels(
    projectId: string,
    type?: LabelType,
  ): Promise<LabelWithChildren[]> {
    return this.prisma.workItemLabel.findMany({
      where: {
        projectId,
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
    type?: LabelType,
    projectId?: string | null,
  ): Promise<Label[]> {
    return this.prisma.workItemLabel.findMany({
      where: {
        createdById: userId,
        ...(projectId !== undefined && { projectId }),
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

  async detachFromWorkItems(
    projectId: string,
    labelId: string,
    labelName?: string,
  ): Promise<number> {
    return this.detachMultipleFromWorkItems(
      projectId,
      [labelId],
      labelName ? [labelName] : [],
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

  async detachFromPages(projectId: string, labelId: string): Promise<number> {
    return this.detachMultipleFromPages(projectId, [labelId]);
  }

  async detachMultipleFromPages(
    projectId: string,
    labelIds: string[],
  ): Promise<number> {
    const targets = Array.from(new Set(labelIds.filter(Boolean)));
    if (!targets.length) return 0;

    try {
      const pageClient = (this.prisma as any).page;
      if (!pageClient) return 0;

      const pages = await pageClient.findMany({
        where: {
          projectId,
          deletedAt: null,
        },
      });

      if (!pages || !pages.length) return 0;

      const targetSet = new Set(targets);
      const updates = pages
        .filter(
          (item: any) =>
            Array.isArray(item.labels) &&
            item.labels.some((l: string) => targetSet.has(l)),
        )
        .map((item: any) => {
          const cleaned = item.labels.filter(
            (label: string) => !targetSet.has(label),
          );
          return pageClient.update({
            where: { id: item.id },
            data: { labels: cleaned },
          });
        });

      if (updates.length > 0) {
        await this.prisma.$transaction(updates);
      }

      return updates.length;
    } catch {
      return 0;
    }
  }

  async createMany(
    data: Prisma.WorkItemLabelUncheckedCreateInput[],
  ): Promise<{ count: number }> {
    return this.prisma.workItemLabel.createMany({
      data,
      skipDuplicates: true,
    });
  }

  // Legacy method preservation
  async findLabelById(labelId: string): Promise<Label | null> {
    return this.findById(labelId);
  }

  async createLabel(
    data:
      | Prisma.WorkItemLabelCreateInput
      | Prisma.WorkItemLabelUncheckedCreateInput,
  ): Promise<Label> {
    return this.create(data as Prisma.WorkItemLabelUncheckedCreateInput);
  }

  async updateLabel(
    labelId: string,
    data:
      | Prisma.WorkItemLabelUpdateInput
      | Prisma.WorkItemLabelUncheckedUpdateInput,
  ): Promise<Label> {
    return this.update(labelId, data);
  }

  async deleteLabel(labelId: string): Promise<Label> {
    return this.delete(labelId);
  }
}
