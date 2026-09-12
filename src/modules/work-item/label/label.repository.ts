import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, LabelType, Label } from '@prisma/client';
import {
  ILabelRepository,
  LabelWithChildren,
  ReorderLabelItem,
} from './types/label.types';

@Injectable()
export class LabelRepository implements ILabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectLabels(projectId: string): Promise<LabelWithChildren[]> {
    return this.prisma.label.findMany({
      where: { projectId },
      include: {
        children: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findWorkspaceLabels(
    workspaceId: string,
    type?: LabelType,
  ): Promise<Label[]> {
    return this.prisma.label.findMany({
      where: {
        workspaceId,
        ...(type && { type }),
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
    return this.prisma.label.findUnique({
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
    return this.prisma.label.findFirst({
      where: {
        projectId,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
  }

  async create(data: Prisma.LabelUncheckedCreateInput): Promise<Label> {
    return this.prisma.label.create({
      data,
    });
  }

  async update(
    labelId: string,
    data: Prisma.LabelUncheckedUpdateInput,
  ): Promise<Label> {
    return this.prisma.label.update({
      where: { id: labelId },
      data,
    });
  }

  async delete(labelId: string): Promise<Label> {
    return this.prisma.label.delete({
      where: { id: labelId },
    });
  }

  async reorder(projectId: string, updates: ReorderLabelItem[]): Promise<void> {
    await this.prisma.$transaction(
      updates.map((item) =>
        this.prisma.label.updateMany({
          where: { id: item.id, projectId },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );
  }

  async detachFromTasks(
    projectId: string,
    labelId: string,
    labelName?: string,
  ): Promise<number> {
    return this.detachMultipleFromTasks(
      projectId,
      [labelId],
      labelName ? [labelName] : [],
    );
  }

  async detachMultipleFromTasks(
    projectId: string,
    labelIds: string[],
    labelNames?: string[],
  ): Promise<number> {
    const targets = Array.from(
      new Set([...labelIds, ...(labelNames || [])].filter(Boolean)),
    );
    if (!targets.length) return 0;

    try {
      const tasks = await this.prisma.task.findMany({
        where: {
          projectId,
          labels: { hasSome: targets },
        },
        select: { id: true, labels: true },
      });

      if (!tasks.length) return 0;

      const targetSet = new Set(targets);
      await this.prisma.$transaction(
        tasks.map((task) => {
          const cleaned = task.labels.filter((label) => !targetSet.has(label));
          return this.prisma.task.update({
            where: { id: task.id },
            data: { labels: cleaned },
          });
        }),
      );

      return tasks.length;
    } catch {
      return 0;
    }
  }

  async createMany(
    data: Prisma.LabelUncheckedCreateInput[],
  ): Promise<{ count: number }> {
    return this.prisma.label.createMany({
      data,
      skipDuplicates: true,
    });
  }

  // Legacy method preservation
  async findLabelById(labelId: string): Promise<Label | null> {
    return this.findById(labelId);
  }

  async createLabel(
    data: Prisma.LabelCreateInput | Prisma.LabelUncheckedCreateInput,
  ): Promise<Label> {
    return this.create(data as Prisma.LabelUncheckedCreateInput);
  }

  async updateLabel(
    labelId: string,
    data: Prisma.LabelUpdateInput | Prisma.LabelUncheckedUpdateInput,
    workspaceId?: string,
  ): Promise<Label> {
    if (workspaceId) {
      const existing = await this.prisma.label.findFirst({
        where: { id: labelId, workspaceId },
      });
      if (!existing) {
        throw new Error('Label not found in workspace');
      }
    }
    return this.update(labelId, data);
  }

  async deleteLabel(labelId: string, workspaceId?: string): Promise<Label> {
    if (workspaceId) {
      const existing = await this.prisma.label.findFirst({
        where: { id: labelId, workspaceId },
      });
      if (!existing) {
        throw new Error('Label not found in workspace');
      }
    }
    return this.delete(labelId);
  }
}
