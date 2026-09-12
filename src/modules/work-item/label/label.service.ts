import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { LabelRepository } from './label.repository';
import {
  CreateProjectLabelDto,
  UpdateProjectLabelDto,
  ReorderLabelsDto,
  CreateLabelDto,
  UpdateLabelDto,
  ImportLabelsDto,
} from './dto/label.dto';
import { LabelType, Label, Prisma } from '@prisma/client';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { resolveTenantWorkspaceId } from '@/core/utils/tenant.util';
import { LabelWithChildren, ImportLabelResult } from './types/label.types';

export const DEFAULT_LABEL_PALETTE = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#06b6d4', // Cyan
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#64748b', // Slate
];

@Injectable()
export class LabelService {
  constructor(
    private readonly labelRepository: LabelRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateLabelCache(workspaceId?: string, projectId?: string) {
    if (!this.cache) return;
    const promises: Promise<void>[] = [];
    if (workspaceId) {
      promises.push(this.cache.del(WORK_ITEM_REDIS_KEYS.labels(workspaceId)));
    }
    if (projectId) {
      promises.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectLabels(projectId)),
      );
    }
    await Promise.all(promises);
  }

  private pickDefaultColor(): string {
    const paletteIndex = Math.floor(Math.random() * DEFAULT_LABEL_PALETTE.length);
    return DEFAULT_LABEL_PALETTE[paletteIndex];
  }

  // ── 1. Project-Scoped Methods ───────────────────────────────────────────────

  async getProjectLabels(projectId: string) {
    const cacheKey = WORK_ITEM_REDIS_KEYS.projectLabels(projectId);
    if (this.cache) {
      const cached = await this.cache.get<{ labels: LabelWithChildren[] }>(
        cacheKey,
      );
      if (cached) return cached;
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    const labels = await this.labelRepository.findProjectLabels(projectId);
    const result = { labels };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }
    return result;
  }

  async getProjectLabelById(projectId: string, labelId: string) {
    const label = await this.labelRepository.findById(labelId);
    if (!label) {
      throw new NotFoundException('Label not found');
    }
    if (label.projectId && label.projectId !== projectId) {
      throw new ForbiddenException('Label does not belong to this project');
    }
    return { label };
  }

  async createProjectLabel(
    projectId: string,
    userId: string,
    dto: CreateProjectLabelDto,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    // 1. Uniqueness check in project
    const existing = await this.labelRepository.findByNameInProject(
      projectId,
      dto.name,
    );
    if (existing) {
      throw new ConflictException(
        `A label with name "${dto.name}" already exists in this project`,
      );
    }

    // 2. Hierarchy validation
    if (dto.parentId) {
      const parent = await this.labelRepository.findById(dto.parentId);
      if (!parent) {
        throw new NotFoundException('Parent label not found');
      }
      if (parent.projectId !== projectId) {
        throw new BadRequestException(
          'Parent label must belong to the same project',
        );
      }
      if (parent.parentId) {
        throw new BadRequestException(
          'Nesting is limited to 1 level deep. Parent label cannot be a sub-label.',
        );
      }
    }

    // 3. Calculate sortOrder if omitted
    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined) {
      const lastLabel = await this.prisma.label.findFirst({
        where: { projectId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = lastLabel ? lastLabel.sortOrder + 10000 : 10000;
    }

    const color = dto.color?.trim() || this.pickDefaultColor();

    const label = await this.labelRepository.create({
      name: dto.name.trim(),
      color,
      description: dto.description?.trim() || null,
      sortOrder,
      parentId: dto.parentId || null,
      projectId,
      workspaceId: project.workspaceId,
      type: LabelType.task,
      createdById: userId,
    });

    await this.invalidateLabelCache(project.workspaceId, projectId);
    return { label };
  }

  async updateProjectLabel(
    projectId: string,
    labelId: string,
    dto: UpdateProjectLabelDto,
  ) {
    const existing = await this.labelRepository.findById(labelId);
    if (!existing) {
      throw new NotFoundException('Label not found');
    }
    if (existing.projectId && existing.projectId !== projectId) {
      throw new ForbiddenException('Label does not belong to this project');
    }

    // 1. Name uniqueness check if changing name
    if (
      dto.name &&
      dto.name.trim().toLowerCase() !== existing.name.toLowerCase()
    ) {
      const duplicate = await this.labelRepository.findByNameInProject(
        projectId,
        dto.name,
        labelId,
      );
      if (duplicate) {
        throw new ConflictException(
          `A label with name "${dto.name}" already exists in this project`,
        );
      }
    }

    // 2. Hierarchy validation
    if (dto.parentId !== undefined) {
      if (dto.parentId === labelId) {
        throw new BadRequestException('A label cannot be its own parent');
      }
      if (dto.parentId) {
        if (existing.children && existing.children.length > 0) {
          throw new BadRequestException(
            'Cannot nest a label that already contains sub-labels. Nesting is limited to 1 level deep.',
          );
        }
        const parent = await this.labelRepository.findById(dto.parentId);
        if (!parent) {
          throw new NotFoundException('Parent label not found');
        }
        if (parent.projectId !== projectId) {
          throw new BadRequestException(
            'Parent label must belong to the same project',
          );
        }
        if (parent.parentId) {
          throw new BadRequestException(
            'Nesting is limited to 1 level deep. Target parent cannot be a sub-label.',
          );
        }
        // Prevent circular dependency: parent cannot have labelId as its ancestor
        let currentParent: LabelWithChildren | null = parent;
        while (currentParent?.parentId) {
          if (currentParent.parentId === labelId) {
            throw new BadRequestException(
              'Circular hierarchy detected: cannot set descendant as parent',
            );
          }
          currentParent = await this.labelRepository.findById(currentParent.parentId);
        }
      }
    }

    const updated = await this.labelRepository.update(labelId, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.color !== undefined && { color: dto.color.trim() }),
      ...(dto.description !== undefined && {
        description: dto.description?.trim() || null,
      }),
      ...(dto.parentId !== undefined && { parentId: dto.parentId }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
    });

    await this.invalidateLabelCache(existing.workspaceId, projectId);
    return { label: updated };
  }

  async deleteProjectLabel(projectId: string, labelId: string) {
    const label = await this.labelRepository.findById(labelId);
    if (!label) {
      throw new NotFoundException('Label not found');
    }
    if (label.projectId && label.projectId !== projectId) {
      throw new ForbiddenException('Label does not belong to this project');
    }

    // 1. Detach label and all its sub-labels from all tasks in project (cascade safe deletion)
    const labelIdsToDetach = [labelId];
    const labelNamesToDetach = [label.name];
    if (label.children && label.children.length > 0) {
      for (const child of label.children) {
        labelIdsToDetach.push(child.id);
        if (child.name) labelNamesToDetach.push(child.name);
      }
    }
    await this.labelRepository.detachMultipleFromTasks(
      projectId,
      labelIdsToDetach,
      labelNamesToDetach,
    );

    // 2. Delete label (Cascade in DB deletes sub-labels)
    await this.labelRepository.delete(labelId);

    await this.invalidateLabelCache(label.workspaceId, projectId);
    return { message: 'Label deleted successfully', labelId };
  }

  async reorderProjectLabels(projectId: string, dto: ReorderLabelsDto) {
    if (!dto.labels?.length) {
      return { message: 'No labels to reorder' };
    }

    await this.labelRepository.reorder(projectId, dto.labels);
    await this.invalidateLabelCache(undefined, projectId);
    return { message: 'Labels reordered successfully' };
  }

  async importProjectLabels(
    projectId: string,
    userId: string,
    dto: ImportLabelsDto,
  ): Promise<ImportLabelResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    if (!dto.labels || !Array.isArray(dto.labels) || !dto.labels.length) {
      return { created: 0, skipped: 0, failed: 0, labels: [] };
    }

    // Existing labels in project for case-insensitive duplicate checking
    const existingLabels = await this.labelRepository.findProjectLabels(projectId);
    const existingNames = new Set(
      existingLabels.map((label) => label.name.trim().toLowerCase()),
    );
    for (const label of existingLabels) {
      if (label.children) {
        for (const childLabel of label.children) {
          existingNames.add(childLabel.name.trim().toLowerCase());
        }
      }
    }

    const seenInBatch = new Set<string>();
    let skipped = 0;
    let failed = 0;
    const toCreate: Prisma.LabelUncheckedCreateInput[] = [];

    const lastLabel = await this.prisma.label.findFirst({
      where: { projectId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    let baseSortOrder = lastLabel ? lastLabel.sortOrder + 10000 : 10000;

    for (const row of dto.labels) {
      if (!row.name || typeof row.name !== 'string' || !row.name.trim()) {
        failed++;
        continue;
      }
      const normalized = row.name.trim().toLowerCase();
      if (existingNames.has(normalized) || seenInBatch.has(normalized)) {
        skipped++;
        continue;
      }
      seenInBatch.add(normalized);

      const color =
        row.color?.trim() &&
        /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(row.color.trim())
          ? row.color.trim()
          : this.pickDefaultColor();

      toCreate.push({
        name: row.name.trim(),
        color,
        description: row.description?.trim() || null,
        projectId,
        workspaceId: project.workspaceId,
        createdById: userId,
        type: LabelType.task,
        sortOrder: baseSortOrder,
      });
      baseSortOrder += 10000;
    }

    const createdLabels: Label[] = [];
    if (toCreate.length > 0) {
      for (const item of toCreate) {
        const created = await this.labelRepository.create(item);
        createdLabels.push(created);
      }
    }

    await this.invalidateLabelCache(project.workspaceId, projectId);

    return {
      created: createdLabels.length,
      skipped,
      failed,
      labels: createdLabels,
    };
  }

  // ── 2. Legacy Workspace-Level Methods (Preserved for Backward Compatibility) ──

  async getLabels(workspaceIdOrSlug: string, type?: LabelType) {
    const workspaceId = await resolveTenantWorkspaceId(
      this.prisma,
      workspaceIdOrSlug,
    );
    const cacheKey = WORK_ITEM_REDIS_KEYS.labels(workspaceId);

    if (this.cache && !type) {
      const cached = await this.cache.get<{ labels: Label[] }>(cacheKey);
      if (cached) return cached;
    }

    const labels = await this.labelRepository.findWorkspaceLabels(workspaceId, type);
    const result = { labels };

    if (this.cache && !type) {
      await this.cache.set(cacheKey, result, 3600);
    }

    return result;
  }

  async createLabel(
    workspaceIdOrSlug: string,
    userId: string,
    dto: CreateLabelDto,
  ) {
    const workspaceId = await resolveTenantWorkspaceId(
      this.prisma,
      workspaceIdOrSlug,
    );

    // If projectId is provided, route to project-scoped creation
    if (dto.projectId) {
      return this.createProjectLabel(dto.projectId, userId, {
        name: dto.name,
        color: dto.color,
        description: dto.description,
        parentId: dto.parentId,
      });
    }

    const color = dto.color || this.pickDefaultColor();
    const label = await this.labelRepository.create({
      name: dto.name.trim(),
      color,
      type: dto.type || LabelType.task,
      description: dto.description || null,
      parentId: dto.parentId || null,
      workspaceId,
      createdById: userId,
    });

    await this.invalidateLabelCache(workspaceId);
    return { label };
  }

  async updateLabel(
    labelId: string,
    dto: UpdateLabelDto,
    workspaceId?: string,
  ) {
    const existing = await this.labelRepository.findById(labelId);
    if (!existing) {
      throw new NotFoundException('Label not found');
    }
    if (workspaceId && existing.workspaceId !== workspaceId) {
      throw new ForbiddenException('Label does not belong to this workspace');
    }

    const label = await this.labelRepository.update(labelId, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.type !== undefined && { type: dto.type }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.parentId !== undefined && { parentId: dto.parentId }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
    });

    await this.invalidateLabelCache(
      label.workspaceId,
      label.projectId || undefined,
    );
    return { label };
  }

  async deleteLabel(labelId: string, workspaceId?: string) {
    const label = await this.labelRepository.findById(labelId);
    if (!label) {
      throw new NotFoundException('Label not found');
    }
    if (workspaceId && label.workspaceId !== workspaceId) {
      throw new ForbiddenException('Label does not belong to this workspace');
    }

    if (label.projectId) {
      await this.labelRepository.detachFromTasks(
        label.projectId,
        labelId,
        label.name,
      );
    }

    await this.labelRepository.delete(labelId);
    await this.invalidateLabelCache(
      label.workspaceId,
      label.projectId || undefined,
    );
    return { message: 'Label deleted successfully' };
  }
}
