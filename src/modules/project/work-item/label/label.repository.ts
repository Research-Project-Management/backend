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

function normalizeLabelSubsystemType(type?: string): string | undefined {
  if (!type) return undefined;
  const t = type.trim().toLowerCase();
  if (t === 'work-item' || t === 'work_item' || t === 'workitems' || t === 'work-items') return 'work_item';
  if (t === 'page' || t === 'pages') return 'page';
  if (t === 'library' || t === 'libraries' || t === 'tag' || t === 'tags') return 'library';
  return t;
}

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectLabels(
    projectId: string,
    type?: string,
  ): Promise<LabelWithChildren[]> {
    const rawType = type?.trim().toLowerCase();
    const isHierarchyFilter =
      rawType === 'root' ||
      rawType === 'parent' ||
      rawType === 'sub' ||
      rawType === 'child';
    const normalizedType = isHierarchyFilter ? rawType : normalizeLabelSubsystemType(type);

    const labels = await this.prisma.spaceLabel.findMany({
      where: {
        spaceId: projectId,
        ...(isHierarchyFilter
          ? normalizedType === 'root' || normalizedType === 'parent'
            ? { parentId: null }
            : { parentId: { not: null } }
          : normalizedType
            ? { type: normalizedType }
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
    const rawType = type?.trim().toLowerCase();
    const isHierarchyFilter =
      rawType === 'root' ||
      rawType === 'parent' ||
      rawType === 'sub' ||
      rawType === 'child';
    const normalizedType = isHierarchyFilter ? rawType : normalizeLabelSubsystemType(type);

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
        ...(isHierarchyFilter
          ? normalizedType === 'root' || normalizedType === 'parent'
            ? { parentId: null }
            : { parentId: { not: null } }
          : normalizedType
            ? { type: normalizedType }
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
    type?: string,
    excludeId?: string,
  ): Promise<Label | null> {
    const label = await this.prisma.spaceLabel.findFirst({
      where: {
        spaceId: projectId,
        ...(type ? { type: type.trim().toLowerCase() } : {}),
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
    type?: string,
  ): Promise<number | null> {
    const lastLabel = await this.prisma.spaceLabel.findFirst({
      where: {
        spaceId: projectId,
        parentId: parentId || null,
        ...(type ? { type: type.trim().toLowerCase() } : {}),
      },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return lastLabel?.sortOrder ?? null;
  }

  async findDuplicate(params: {
    projectId: string | null;
    name: string;
    type?: string;
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
        ...(params.type ? { type: params.type.trim().toLowerCase() } : {}),
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
      type?: string;
    },
  ): Promise<Label> {
    const { projectId, spaceId, type, ...rest } = data;
    const effectiveSpaceId = spaceId || projectId || rest.createdById;
    const created = await this.prisma.spaceLabel.create({
      data: {
        ...rest,
        spaceId: effectiveSpaceId,
        type: normalizeLabelSubsystemType(type) || 'work_item',
      },
    });

    if (created.type === 'library' && this.prisma.libraryTag) {
      try {
        const normalized = created.name.trim().toLowerCase();
        await this.prisma.libraryTag.upsert({
          where: {
            spaceId_normalizedName: {
              spaceId: created.spaceId,
              normalizedName: normalized,
            },
          },
          update: {
            name: created.name,
            color: created.color,
          },
          create: {
            spaceId: created.spaceId,
            name: created.name,
            normalizedName: normalized,
            color: created.color,
            createdById: created.createdById,
            type: 'manual',
          },
        });
      } catch {
        // Non-blocking sync to library_tags
      }
    }

    return mapLabel(created);
  }

  async update(
    labelId: string,
    data: Prisma.SpaceLabelUncheckedUpdateInput & { type?: string },
  ): Promise<Label> {
    const updateData = { ...data };
    if (typeof updateData.type === 'string') {
      updateData.type =
        normalizeLabelSubsystemType(updateData.type) || updateData.type;
    }
    const updated = await this.prisma.spaceLabel.update({
      where: { id: labelId },
      data: updateData,
    });

    if (updated.type === 'library' && this.prisma.libraryTag) {
      try {
        const normalized = updated.name.trim().toLowerCase();
        const existing = await this.prisma.libraryTag.findFirst({
          where: {
            spaceId: updated.spaceId,
            name: { equals: updated.name, mode: 'insensitive' },
          },
        });
        if (existing) {
          await this.prisma.libraryTag.update({
            where: { id: existing.id },
            data: {
              name: updated.name,
              normalizedName: normalized,
              color: updated.color,
            },
          });
        }
      } catch {
        // Non-blocking sync to library_tags
      }
    }

    return mapLabel(updated);
  }

  async delete(labelId: string): Promise<Label> {
    const deleted = await this.prisma.spaceLabel.delete({
      where: { id: labelId },
    });

    if (deleted.type === 'library' && this.prisma.libraryTag) {
      try {
        const normalized = deleted.name.trim().toLowerCase();
        await this.prisma.libraryTag.deleteMany({
          where: {
            spaceId: deleted.spaceId,
            normalizedName: normalized,
            itemTags: { none: {} },
          },
        });
      } catch {
        // Non-blocking sync to library_tags
      }
    }

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
