import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ViewAccess } from '@prisma/client';
import { WorkItemViewItem } from './types/view.types';
import { QueryViewDto } from './dto/view.dto';

@Injectable()
export class ViewRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findProjectViews(
    projectId: string,
    userId: string,
    queryViewDto?: QueryViewDto,
  ): Promise<WorkItemViewItem[]> {
    const whereClause: any = {
      projectId,
      OR: [
        { access: ViewAccess.public },
        { access: ViewAccess.private, createdById: userId },
      ],
    };

    if (queryViewDto?.access) {
      whereClause.access = queryViewDto.access;
    }

    if (queryViewDto?.search) {
      whereClause.AND = [
        {
          OR: [
            { name: { contains: queryViewDto.search, mode: 'insensitive' } },
            { description: { contains: queryViewDto.search, mode: 'insensitive' } },
          ],
        },
      ];
    }

    if (queryViewDto?.isFavorite) {
      whereClause.favorites = {
        some: { userId },
      };
    }

    const records = await (this.prismaService as any).workItemView.findMany({
      where: whereClause,
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
            email: true,
          },
        },
        favorites: {
          where: { userId },
          select: { id: true },
        },
      },
      orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
    });

    const mapped = records.map((record: any) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      query: (record.query as Record<string, any>) || {},
      filters: (record.filters as Record<string, any>) || {},
      displayFilters: (record.displayFilters as Record<string, any>) || {},
      displayProperties: (record.displayProperties as Record<string, any>) || {},
      richFilters: (record.richFilters as Record<string, any>) || {},
      access: record.access,
      sortOrder: record.sortOrder ?? 65535,
      logoProps: (record.logoProps as Record<string, any>) || {},
      isLocked: record.isLocked,
      archivedAt: record.archivedAt,
      projectId: record.projectId,
      createdById: record.createdById,
      createdBy: record.createdBy,
      isFavorite: Array.isArray(record.favorites) && record.favorites.length > 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));

    // Plane.so ordering: order_by("-is_favorite", "name")
    return mapped.sort((firstView: any, secondView: any) => {
      if (firstView.isFavorite && !secondView.isFavorite) return -1;
      if (!firstView.isFavorite && secondView.isFavorite) return 1;
      return (firstView.name || '').localeCompare(secondView.name || '');
    });
  }

  async findById(viewId: string, userId?: string): Promise<WorkItemViewItem | null> {
    const record = await (this.prismaService as any).workItemView.findUnique({
      where: { id: viewId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
            email: true,
          },
        },
        favorites: userId
          ? {
              where: { userId },
              select: { id: true },
            }
          : false,
      },
    });

    if (!record) return null;

    return {
      id: record.id,
      name: record.name,
      description: record.description,
      query: (record.query as Record<string, any>) || {},
      filters: (record.filters as Record<string, any>) || {},
      displayFilters: (record.displayFilters as Record<string, any>) || {},
      displayProperties: (record.displayProperties as Record<string, any>) || {},
      richFilters: (record.richFilters as Record<string, any>) || {},
      access: record.access,
      sortOrder: record.sortOrder ?? 65535,
      logoProps: (record.logoProps as Record<string, any>) || {},
      isLocked: record.isLocked,
      archivedAt: record.archivedAt,
      projectId: record.projectId,
      createdById: record.createdById,
      createdBy: record.createdBy,
      isFavorite:
        Array.isArray(record.favorites) && record.favorites.length > 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async create(data: {
    name: string;
    description?: string;
    query?: Record<string, any>;
    filters?: Record<string, any>;
    displayFilters?: Record<string, any>;
    displayProperties?: Record<string, any>;
    richFilters?: Record<string, any>;
    access?: ViewAccess;
    sortOrder?: number;
    logoProps?: Record<string, any>;
    projectId: string;
    createdById: string;
  }): Promise<WorkItemViewItem> {
    const record = await (this.prismaService as any).workItemView.create({
      data: {
        name: data.name,
        description: data.description ?? '',
        query: data.query ?? data.filters ?? {},
        filters: data.filters ?? data.query ?? {},
        displayFilters: data.displayFilters ?? {},
        displayProperties: data.displayProperties ?? {},
        richFilters: data.richFilters ?? {},
        access: data.access ?? ViewAccess.public,
        sortOrder: data.sortOrder ?? 65535,
        logoProps: data.logoProps ?? {},
        projectId: data.projectId,
        createdById: data.createdById,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
            email: true,
          },
        },
      },
    });

    return {
      id: record.id,
      name: record.name,
      description: record.description,
      query: (record.query as Record<string, any>) || {},
      filters: (record.filters as Record<string, any>) || {},
      displayFilters: (record.displayFilters as Record<string, any>) || {},
      displayProperties: (record.displayProperties as Record<string, any>) || {},
      richFilters: (record.richFilters as Record<string, any>) || {},
      access: record.access,
      sortOrder: record.sortOrder ?? 65535,
      logoProps: (record.logoProps as Record<string, any>) || {},
      isLocked: record.isLocked,
      archivedAt: record.archivedAt,
      projectId: record.projectId,
      createdById: record.createdById,
      createdBy: record.createdBy,
      isFavorite: false,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async update(
    viewId: string,
    data: {
      name?: string;
      description?: string;
      query?: Record<string, any>;
      filters?: Record<string, any>;
      displayFilters?: Record<string, any>;
      displayProperties?: Record<string, any>;
      richFilters?: Record<string, any>;
      access?: ViewAccess;
      sortOrder?: number;
      logoProps?: Record<string, any>;
      isLocked?: boolean;
      archivedAt?: string | null;
    },
    userId?: string,
  ): Promise<WorkItemViewItem> {
    const record = await (this.prismaService as any).workItemView.update({
      where: { id: viewId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.query !== undefined && { query: data.query }),
        ...(data.filters !== undefined && { filters: data.filters }),
        ...(data.displayFilters !== undefined && {
          displayFilters: data.displayFilters,
        }),
        ...(data.displayProperties !== undefined && {
          displayProperties: data.displayProperties,
        }),
        ...(data.richFilters !== undefined && {
          richFilters: data.richFilters,
        }),
        ...(data.access !== undefined && { access: data.access }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.logoProps !== undefined && { logoProps: data.logoProps }),
        ...(data.isLocked !== undefined && { isLocked: data.isLocked }),
        ...(data.archivedAt !== undefined && {
          archivedAt: data.archivedAt ? new Date(data.archivedAt) : null,
        }),
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
            email: true,
          },
        },
        favorites: userId
          ? {
              where: { userId },
              select: { id: true },
            }
          : false,
      },
    });

    return {
      id: record.id,
      name: record.name,
      description: record.description,
      query: (record.query as Record<string, any>) || {},
      filters: (record.filters as Record<string, any>) || {},
      displayFilters: (record.displayFilters as Record<string, any>) || {},
      displayProperties: (record.displayProperties as Record<string, any>) || {},
      richFilters: (record.richFilters as Record<string, any>) || {},
      access: record.access,
      sortOrder: record.sortOrder ?? 65535,
      logoProps: (record.logoProps as Record<string, any>) || {},
      isLocked: record.isLocked,
      archivedAt: record.archivedAt,
      projectId: record.projectId,
      createdById: record.createdById,
      createdBy: record.createdBy,
      isFavorite:
        Array.isArray(record.favorites) && record.favorites.length > 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async delete(viewId: string): Promise<boolean> {
    try {
      await (this.prismaService as any).workItemView.delete({
        where: { id: viewId },
      });
      return true;
    } catch {
      return false;
    }
  }

  async toggleFavorite(
    viewId: string,
    userId: string,
  ): Promise<{ isFavorite: boolean }> {
    const existing = await (this.prismaService as any).viewFavorite.findUnique({
      where: {
        viewId_userId: {
          viewId,
          userId,
        },
      },
    });

    if (existing) {
      await (this.prismaService as any).viewFavorite.delete({
        where: {
          viewId_userId: {
            viewId,
            userId,
          },
        },
      });
      return { isFavorite: false };
    } else {
      await (this.prismaService as any).viewFavorite.create({
        data: {
          viewId,
          userId,
        },
      });
      return { isFavorite: true };
    }
  }

  async isFavorite(viewId: string, userId: string): Promise<boolean> {
    const record = await (this.prismaService as any).viewFavorite.findUnique({
      where: {
        viewId_userId: {
          viewId,
          userId,
        },
      },
      select: { id: true },
    });
    return !!record;
  }

  async favorite(viewId: string, userId: string): Promise<boolean> {
    try {
      await (this.prismaService as any).viewFavorite.upsert({
        where: {
          viewId_userId: {
            viewId,
            userId,
          },
        },
        create: { viewId, userId },
        update: {},
      });
      return true;
    } catch {
      return false;
    }
  }

  async unfavorite(viewId: string, userId: string): Promise<boolean> {
    try {
      await (this.prismaService as any).viewFavorite.delete({
        where: {
          viewId_userId: {
            viewId,
            userId,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async findUserFavoriteViews(projectId: string, userId: string): Promise<any[]> {
    const favorites = await (this.prismaService as any).viewFavorite.findMany({
      where: {
        userId,
        view: { projectId },
      },
      include: {
        view: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return favorites.map((favorite: any) => ({
      id: favorite.id,
      viewId: favorite.viewId,
      view: favorite.view,
      userId: favorite.userId,
      createdAt: favorite.createdAt,
    }));
  }
}

