import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUuid } from '@/core/utils/tenant.util';
import { Prisma } from '@prisma/client';
import { USER_MINIMAL_SELECT } from '../core/types/work-item.types';
import { QueryTemplateDto } from './dto/query-template.dto';

@Injectable()
export class TemplateRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async resolveProjectId(projectIdOrIdentifier: string): Promise<string | null> {
    if (isUuid(projectIdOrIdentifier)) {
      return projectIdOrIdentifier;
    }
    const project = await this.prismaService.project.findFirst({
      where: {
        identifier: { equals: projectIdOrIdentifier, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true },
    });
    return project?.id || null;
  }

  async createTemplate(data: Prisma.WorkItemTemplateUncheckedCreateInput) {
    return this.prismaService.workItemTemplate.create({
      data,
      include: {
        author: { select: USER_MINIMAL_SELECT },
        project: { select: { id: true, identifier: true, workspaceId: true, name: true } },
      },
    });
  }

  async findTemplateById(id: string) {
    if (!isUuid(id)) return null;

    return this.prismaService.workItemTemplate.findFirst({
      where: { id, deletedAt: null },
      include: {
        author: { select: USER_MINIMAL_SELECT },
        project: { select: { id: true, identifier: true, workspaceId: true, name: true } },
      },
    });
  }

  async findTemplatesByProject(projectId: string, queryTemplateDto: QueryTemplateDto) {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) {
      return { templates: [], total: 0, page: 1, limit: queryTemplateDto.limit || 50 };
    }

    const where: Prisma.WorkItemTemplateWhereInput = {
      projectId: canonicalProjectId,
      deletedAt: null,
    };

    if (queryTemplateDto.search?.trim()) {
      const search = queryTemplateDto.search.trim();
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const page = Math.max(1, queryTemplateDto.page || 1);
    const limit = Math.min(200, Math.max(1, queryTemplateDto.limit || 50));
    const skip = (page - 1) * limit;

    const [total, templates] = await Promise.all([
      this.prismaService.workItemTemplate.count({ where }),
      this.prismaService.workItemTemplate.findMany({
        where,
        include: {
          author: { select: USER_MINIMAL_SELECT },
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    return {
      templates,
      total,
      page,
      limit,
    };
  }

  async updateTemplate(
    id: string,
    data: Prisma.WorkItemTemplateUncheckedUpdateInput,
  ) {
    return this.prismaService.workItemTemplate.update({
      where: { id },
      data,
      include: {
        author: { select: USER_MINIMAL_SELECT },
        project: { select: { id: true, identifier: true, workspaceId: true, name: true } },
      },
    });
  }

  async unsetOtherDefaults(projectId: string, exceptTemplateId: string) {
    return this.prismaService.workItemTemplate.updateMany({
      where: {
        projectId,
        id: { not: exceptTemplateId },
        isDefault: true,
      },
      data: { isDefault: false },
    });
  }

  async softDeleteTemplate(id: string) {
    return this.prismaService.workItemTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
