import { Injectable } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { Prisma, SpaceLabel } from '@prisma/client';
import { Label, LabelWithChildren, ReorderLabelItem } from './dto/label.dto';

function mapLabel(raw: SpaceLabel): Label {
  const isPersonal = raw.spaceId === raw.createdById;
  return {
    ...raw,
    projectId: isPersonal ? null : raw.spaceId,
  };
}

function mapLabelWithChildren(
  raw: SpaceLabel & {
    children?: SpaceLabel[];
    parent?: SpaceLabel | null;
  },
): LabelWithChildren {
  return {
    ...mapLabel(raw),
    ...(raw.children ? { children: raw.children.map(mapLabel) } : {}),
    ...(raw.parent !== undefined
      ? { parent: raw.parent ? mapLabel(raw.parent) : null }
      : {}),
  };
}

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectLabels(
    projectId: string,
    type?: string,
  ): Promise<LabelWithChildren[]> {
    const normalizedType = type?.trim().toLowerCase();
    const labels = await this.prisma.spaceLabel.findMany({
      where: {
        spaceId: projectId,
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
    return labels.map(mapLabelWithChildren);
  }

  async findUserLabels(
    userId: string,
    type?: string,
    projectId?: string | null,
  ): Promise<Label[]> {
    const normalizedType = type?.trim().toLowerCase();
    const effectiveSpaceId =
      projectId &&
      !['personal', 'me', 'user', 'null', 'undefined', 'default', ''].includes(
        projectId.trim().toLowerCase(),
      ) &&
      isUuid(projectId.trim())
        ? projectId.trim()
        : userId;
    const spaceFilter =
      projectId !== undefined ? { spaceId: effectiveSpaceId } : {};
    const labels = await this.prisma.spaceLabel.findMany({
      where: {
        createdById: userId,
        ...spaceFilter,
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
    return labels.map(mapLabelWithChildren);
  }

  async findById(labelId: string): Promise<LabelWithChildren | null> {
    const label = await this.prisma.spaceLabel.findUnique({
      where: { id: labelId },
      include: {
        children: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
        parent: true,
      },
    });
    return label ? mapLabelWithChildren(label) : null;
  }

  async findByNameInProject(
    projectId: string,
    name: string,
    excludeId?: string,
  ): Promise<Label | null> {
    const label = await this.prisma.spaceLabel.findFirst({
      where: {
        spaceId: projectId,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
    return label ? mapLabel(label) : null;
  }

  async findProject(projectId: string): Promise<{ id: string } | null> {
    if (!isUuid(projectId)) return null;
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
  }

  async getLastSortOrder(
    projectId: string,
    parentId?: string | null,
  ): Promise<number | null> {
    const lastLabel = await this.prisma.spaceLabel.findFirst({
      where: {
        spaceId: projectId,
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
    const spaceId = params.projectId || params.createdById;
    const label = await this.prisma.spaceLabel.findFirst({
      where: {
        ...(params.excludeId && { id: { not: params.excludeId } }),
        ...(params.createdById && { createdById: params.createdById }),
        ...(spaceId && { spaceId }),
        name: { equals: params.name.trim(), mode: 'insensitive' },
        parentId: params.parentId ?? null,
      },
    });
    return label ? mapLabel(label) : null;
  }

  async create(
    data: Omit<Prisma.SpaceLabelUncheckedCreateInput, 'spaceId'> & {
      spaceId?: string;
      projectId?: string | null;
    },
  ): Promise<Label> {
    const { projectId, spaceId, ...rest } = data;
    const effectiveSpaceId = spaceId || projectId || rest.createdById;
    const created = await this.prisma.spaceLabel.create({
      data: {
        ...rest,
        spaceId: effectiveSpaceId,
      },
    });
    return mapLabel(created);
  }

  async update(
    labelId: string,
    data: Prisma.SpaceLabelUncheckedUpdateInput,
  ): Promise<Label> {
    const updated = await this.prisma.spaceLabel.update({
      where: { id: labelId },
      data,
    });
    return mapLabel(updated);
  }

  async delete(labelId: string): Promise<Label> {
    const deleted = await this.prisma.spaceLabel.delete({
      where: { id: labelId },
    });
    return mapLabel(deleted);
  }

  async reorder(projectId: string, updates: ReorderLabelItem[]): Promise<void> {
    await this.prisma.$transaction(
      updates.map((item) =>
        this.prisma.spaceLabel.updateMany({
          where: { id: item.id, spaceId: projectId },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );
  }

  async detachMultipleFromWorkItems(
    projectId: string,
    labelIds: string[],
    _labelNames?: string[],
  ): Promise<number> {
    const validLabelIds = Array.from(new Set(labelIds.filter(Boolean)));
    if (!validLabelIds.length) return 0;

    try {
      const result = await this.prisma.workItemLabelAssignment.deleteMany({
        where: {
          labelId: { in: validLabelIds },
          workItem: { projectId },
        },
      });
      return result.count;
    } catch {
      return 0;
    }
  }
}
