import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { CreateDraftDto, UpdateDraftDto } from './dto/draft.dto';
import { Prisma, WorkItemDraft } from '@prisma/client';

const PERSONAL_DRAFT_ALIASES = new Set([
  'personal',
  'me',
  'user',
  'null',
  'undefined',
  'default',
  '',
]);

export function normalizeDraftProjectId(
  projectId?: string | null,
  userId?: string,
): string | undefined {
  if (projectId === undefined || projectId === null) return undefined;
  const trimmed = projectId.trim();
  if (PERSONAL_DRAFT_ALIASES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (userId && trimmed.toLowerCase() === userId.trim().toLowerCase()) {
    return undefined;
  }
  if (!isUuid(trimmed)) {
    throw new BadRequestException('Invalid projectId: expected a valid UUID');
  }
  return trimmed;
}

export type MappedDraft = WorkItemDraft & {
  description: string;
  columnId: string | null;
  projectId: string | null;
  authorId: string;
  project: {
    id: string;
    name: string;
    identifier: string | null;
    states?: Array<{ id: string; name: string; isDefault: boolean }>;
  } | null;
};

@Injectable()
export class DraftRepository {
  constructor(private readonly prismaService: PrismaService) {}

  private async hydrateProjects(drafts: WorkItemDraft[]): Promise<MappedDraft[]> {
    if (drafts.length === 0) return [];
    const spaceIds = Array.from(
      new Set(drafts.map((d) => d.spaceId).filter(isUuid)),
    );
    const projects =
      spaceIds.length > 0 && this.prismaService.project?.findMany
        ? await this.prismaService.project
            .findMany({
              where: { id: { in: spaceIds }, deletedAt: null },
              select: {
                id: true,
                name: true,
                identifier: true,
                states: { select: { id: true, name: true, isDefault: true } },
              },
            })
            .catch(() => [])
        : [];
    const projectMap = new Map(projects.map((p) => [p.id, p]));

    return drafts.map((d) => {
      const proj = projectMap.get(d.spaceId) ?? null;
      const isPersonalSpace = d.spaceId === d.createdById && !proj;
      return {
        ...d,
        description: d.content,
        columnId: d.stateId,
        projectId: isPersonalSpace ? null : d.spaceId,
        authorId: d.createdById,
        project: proj,
      };
    });
  }

  async create(data: CreateDraftDto, authorId: string): Promise<MappedDraft> {
    const normalizedProjectId = normalizeDraftProjectId(
      data.projectId,
      authorId,
    );
    const spaceId = normalizedProjectId || authorId;
    const created = await this.prismaService.workItemDraft.create({
      data: {
        title: data.title ?? '',
        content: data.content ?? data.description ?? '',
        stateId: data.columnId && isUuid(data.columnId) ? data.columnId : null,
        priority: data.priority ?? 'none',
        startDate: data.startDate ? new Date(data.startDate) : null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        labels: data.labels ?? [],
        assigneeId: data.assigneeId ?? null,
        assigneeIds: data.assigneeIds ?? [],
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
        spaceId,
        createdById: authorId,
      },
    });
    const [mapped] = await this.hydrateProjects([created]);
    return mapped;
  }

  async findById(id: string, authorId?: string): Promise<MappedDraft | null> {
    const draft = await this.prismaService.workItemDraft.findFirst({
      where: {
        id,
        ...(authorId ? { createdById: authorId } : {}),
      },
    });
    if (!draft) return null;
    const [mapped] = await this.hydrateProjects([draft]);
    return mapped;
  }

  async findUserDrafts(
    authorId: string,
    filter: { projectId?: string; search?: string },
    skip = 0,
    take = 50,
  ) {
    const normalizedProjectId = normalizeDraftProjectId(
      filter.projectId,
      authorId,
    );
    const where: Prisma.WorkItemDraftWhereInput = {
      createdById: authorId,
      ...(normalizedProjectId ? { spaceId: normalizedProjectId } : {}),
      ...(filter.search
        ? { title: { contains: filter.search, mode: 'insensitive' } }
        : {}),
    };

    const [total, rawDrafts] = await Promise.all([
      this.prismaService.workItemDraft.count({ where }),
      this.prismaService.workItemDraft.findMany({
        where,
        skip,
        take,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const drafts = await this.hydrateProjects(rawDrafts);
    return { total, drafts };
  }

  async update(
    id: string,
    authorId: string,
    data: UpdateDraftDto,
  ): Promise<MappedDraft> {
    const nextContent =
      data.content !== undefined
        ? data.content
        : data.description !== undefined
          ? data.description
          : undefined;
    const updated = await this.prismaService.workItemDraft.update({
      where: { id, createdById: authorId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(nextContent !== undefined ? { content: nextContent } : {}),
        ...(data.columnId !== undefined
          ? { stateId: data.columnId && isUuid(data.columnId) ? data.columnId : null }
          : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.startDate !== undefined
          ? { startDate: data.startDate ? new Date(data.startDate) : null }
          : {}),
        ...(data.dueDate !== undefined
          ? { dueDate: data.dueDate ? new Date(data.dueDate) : null }
          : {}),
        ...(data.labels !== undefined ? { labels: data.labels } : {}),
        ...(data.assigneeId !== undefined
          ? { assigneeId: data.assigneeId }
          : {}),
        ...(data.assigneeIds !== undefined
          ? { assigneeIds: data.assigneeIds }
          : {}),
        ...(data.metadata !== undefined
          ? { metadata: data.metadata as Prisma.InputJsonValue }
          : {}),
        ...(data.projectId !== undefined
          ? {
              spaceId:
                normalizeDraftProjectId(data.projectId, authorId) || authorId,
            }
          : {}),
      },
    });
    const [mapped] = await this.hydrateProjects([updated]);
    return mapped;
  }

  async delete(id: string, authorId: string) {
    return this.prismaService.workItemDraft.deleteMany({
      where: { id, createdById: authorId },
    });
  }
}
