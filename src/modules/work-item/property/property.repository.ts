import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  DEFAULT_FILTERS,
  DEFAULT_DISPLAY_FILTERS,
  DEFAULT_DISPLAY_PROPERTIES,
  DEFAULT_PREFERENCES,
  ProjectUserPropertyData,
} from './types/property.types';

@Injectable()
export class PropertyRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapRecord(record: any): ProjectUserPropertyData & {
    display_filters: Record<string, any>;
    display_properties: Record<string, any>;
    rich_filters: Record<string, any>;
    sort_order: number;
    project_id: string;
    user_id: string;
  } {
    const displayFilters = (record.displayFilters as Record<string, any>) || DEFAULT_DISPLAY_FILTERS;
    const displayProperties = (record.displayProperties as Record<string, any>) || DEFAULT_DISPLAY_PROPERTIES;
    const richFilters = (record.richFilters as Record<string, any>) || {};
    const filters = (record.filters as Record<string, any>) || DEFAULT_FILTERS;
    const preferences = (record.preferences as Record<string, any>) || DEFAULT_PREFERENCES;
    const sortOrder = record.sortOrder ?? 65535;

    return {
      id: record.id,
      projectId: record.projectId,
      project_id: record.projectId,
      userId: record.userId,
      user_id: record.userId,
      filters,
      displayFilters,
      display_filters: displayFilters,
      displayProperties,
      display_properties: displayProperties,
      richFilters,
      rich_filters: richFilters,
      preferences,
      sortOrder,
      sort_order: sortOrder,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async getOrCreate(
    projectId: string,
    userId: string,
  ): Promise<any> {
    const existing = await (this.prisma as any).projectUserProperty.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });

    if (existing) {
      return this.mapRecord(existing);
    }

    const created = await (this.prisma as any).projectUserProperty.create({
      data: {
        projectId,
        userId,
        filters: DEFAULT_FILTERS,
        displayFilters: DEFAULT_DISPLAY_FILTERS,
        displayProperties: DEFAULT_DISPLAY_PROPERTIES,
        preferences: DEFAULT_PREFERENCES,
        richFilters: {},
        sortOrder: 65535,
      },
    });

    return this.mapRecord(created);
  }

  async update(
    projectId: string,
    userId: string,
    data: {
      filters?: Record<string, any>;
      displayFilters?: Record<string, any>;
      displayProperties?: Record<string, any>;
      richFilters?: Record<string, any>;
      preferences?: Record<string, any>;
      sortOrder?: number;
    },
  ): Promise<any> {
    // Ensure record exists before update
    await this.getOrCreate(projectId, userId);

    const updateData: any = {};
    if (data.filters !== undefined) {
      updateData.filters = data.filters;
    }
    if (data.displayFilters !== undefined) {
      updateData.displayFilters = data.displayFilters;
    }
    if (data.displayProperties !== undefined) {
      updateData.displayProperties = data.displayProperties;
    }
    if (data.richFilters !== undefined) {
      updateData.richFilters = data.richFilters;
    }
    if (data.preferences !== undefined) {
      updateData.preferences = data.preferences;
    }
    if (data.sortOrder !== undefined) {
      updateData.sortOrder = data.sortOrder;
    }

    const updated = await (this.prisma as any).projectUserProperty.update({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      data: updateData,
    });

    return this.mapRecord(updated);
  }
}
