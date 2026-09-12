import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class DraftRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async create(data: CreateDraftDto, authorId: string) {
    return this.prismaService.workItemDraft.create({
      data: {
        title: data.title ?? '',
        content: data.content ?? data.description ?? '',
        description: data.description ?? data.content ?? '',
        columnId: data.columnId,
        priority: data.priority ?? 'none',
        startDate: data.startDate ? new Date(data.startDate) : null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        labels: data.labels ?? [],
        assigneeId: data.assigneeId,
        assigneeIds: (data.assigneeIds ?? []) as Prisma.InputJsonValue,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
        projectId: data.projectId,
        authorId,
      },
      include: {
        project: {
          select: { id: true, name: true, identifier: true },
        },
      },
    });
  }

  async findById(id: string, authorId?: string) {
    return this.prismaService.workItemDraft.findFirst({
      where: {
        id,
        ...(authorId ? { authorId } : {}),
      },
      include: {
        project: {
          select: { id: true, name: true, identifier: true, taskColumns: true },
        },
      },
    });
  }

  async findUserDrafts(
    authorId: string,
    filter: { projectId?: string; search?: string },
    skip = 0,
    take = 50,
  ) {
    const where: Prisma.WorkItemDraftWhereInput = {
      authorId,
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.search
        ? { title: { contains: filter.search, mode: 'insensitive' } }
        : {}),
    };

    const [total, drafts] = await Promise.all([
      this.prismaService.workItemDraft.count({ where }),
      this.prismaService.workItemDraft.findMany({
        where,
        skip,
        take,
        orderBy: { updatedAt: 'desc' },
        include: {
          project: {
            select: { id: true, name: true, identifier: true },
          },
        },
      }),
    ]);

    return { total, drafts };
  }

  async update(id: string, authorId: string, data: UpdateDraftDto) {
    return this.prismaService.workItemDraft.update({
      where: { id, authorId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.content !== undefined ? { content: data.content } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.columnId !== undefined ? { columnId: data.columnId } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.startDate !== undefined
          ? { startDate: data.startDate ? new Date(data.startDate) : null }
          : {}),
        ...(data.dueDate !== undefined
          ? { dueDate: data.dueDate ? new Date(data.dueDate) : null }
          : {}),
        ...(data.labels !== undefined ? { labels: data.labels } : {}),
        ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
        ...(data.assigneeIds !== undefined
          ? { assigneeIds: data.assigneeIds as Prisma.InputJsonValue }
          : {}),
        ...(data.metadata !== undefined
          ? { metadata: data.metadata as Prisma.InputJsonValue }
          : {}),
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
      },
      include: {
        project: {
          select: { id: true, name: true, identifier: true },
        },
      },
    });
  }

  async delete(id: string, authorId: string) {
    return this.prismaService.workItemDraft.deleteMany({
      where: { id, authorId },
    });
  }
}

