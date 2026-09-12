import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ViewRepository } from './view.repository';
import { CreateViewDto, UpdateViewDto, QueryViewDto } from './dto/view.dto';
import { WorkItemViewItem } from './types/view.types';
import { WorkItemService } from '../core/work-item.service';
import { QueryWorkItemDto } from '../core/dto/query-work-item.dto';

@Injectable()
export class ViewService {
  constructor(
    private readonly viewRepository: ViewRepository,
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => WorkItemService))
    private readonly workItemService: WorkItemService,
  ) {}

  async getViews(
    projectId: string,
    userId: string,
    queryViewDto?: QueryViewDto,
  ): Promise<WorkItemViewItem[]> {
    return this.viewRepository.findProjectViews(projectId, userId, queryViewDto);
  }

  async getView(
    projectId: string,
    viewId: string,
    userId: string,
    userRole?: string,
  ): Promise<WorkItemViewItem> {
    const view = await this.viewRepository.findById(viewId, userId);
    if (!view || view.projectId !== projectId) {
      throw new NotFoundException('Saved view not found in this project');
    }

    if (
      view.access === 'private' &&
      view.createdById !== userId &&
      userRole !== 'admin'
    ) {
      throw new ForbiddenException(
        'You do not have permission to view this private saved view',
      );
    }

    return view;
  }

  async createView(
    projectId: string,
    userId: string,
    createViewDto: CreateViewDto,
  ): Promise<WorkItemViewItem> {
    const filters = createViewDto.filters ?? createViewDto.query ?? {};
    const query = createViewDto.query ?? createViewDto.filters ?? {};

    const view = await this.viewRepository.create({
      name: createViewDto.name,
      description: createViewDto.description,
      query,
      filters,
      displayFilters: createViewDto.displayFilters ?? {},
      displayProperties: createViewDto.displayProperties ?? {},
      richFilters: createViewDto.richFilters ?? {},
      access: createViewDto.access,
      sortOrder: createViewDto.sortOrder,
      logoProps: createViewDto.logoProps,
      projectId,
      createdById: userId,
    });

    this.eventEmitter.emit('work-item.view.created', {
      viewId: view.id,
      projectId,
      actorId: userId,
      access: view.access,
      name: view.name,
    });

    return view;
  }

  async updateView(
    projectId: string,
    viewId: string,
    userId: string,
    updateViewDto: UpdateViewDto,
    userRole?: string,
  ): Promise<WorkItemViewItem> {
    const existing = await this.viewRepository.findById(viewId, userId);
    if (!existing || existing.projectId !== projectId) {
      throw new NotFoundException('Saved view not found in this project');
    }

    // Lock check: if view is locked, only creator or project admin can update
    if (
      existing.isLocked &&
      existing.createdById !== userId &&
      userRole !== 'admin'
    ) {
      throw new ForbiddenException(
        'This saved view is locked and can only be modified by its creator or a project admin',
      );
    }

    // Private view check: only creator or project admin can modify
    if (
      existing.access === 'private' &&
      existing.createdById !== userId &&
      userRole !== 'admin'
    ) {
      throw new ForbiddenException(
        'You do not have permission to modify this private view',
      );
    }

    const query = updateViewDto.query ?? updateViewDto.filters;
    const filters = updateViewDto.filters ?? updateViewDto.query;

    const updated = await this.viewRepository.update(
      viewId,
      {
        ...(updateViewDto.name !== undefined && { name: updateViewDto.name }),
        ...(updateViewDto.description !== undefined && { description: updateViewDto.description }),
        ...(query !== undefined && { query }),
        ...(filters !== undefined && { filters }),
        ...(updateViewDto.displayFilters !== undefined && {
          displayFilters: updateViewDto.displayFilters,
        }),
        ...(updateViewDto.displayProperties !== undefined && {
          displayProperties: updateViewDto.displayProperties,
        }),
        ...(updateViewDto.richFilters !== undefined && {
          richFilters: updateViewDto.richFilters,
        }),
        ...(updateViewDto.access !== undefined && { access: updateViewDto.access }),
        ...(updateViewDto.sortOrder !== undefined && { sortOrder: updateViewDto.sortOrder }),
        ...(updateViewDto.logoProps !== undefined && { logoProps: updateViewDto.logoProps }),
        ...(updateViewDto.isLocked !== undefined && { isLocked: updateViewDto.isLocked }),
        ...(updateViewDto.archivedAt !== undefined && { archivedAt: updateViewDto.archivedAt }),
      },
      userId,
    );

    this.eventEmitter.emit('work-item.view.updated', {
      viewId,
      projectId,
      actorId: userId,
      changes: updateViewDto,
    });

    return updated;
  }

  async deleteView(
    projectId: string,
    viewId: string,
    userId: string,
    userRole?: string,
  ): Promise<{ success: boolean }> {
    const existing = await this.viewRepository.findById(viewId, userId);
    if (!existing || existing.projectId !== projectId) {
      throw new NotFoundException('Saved view not found in this project');
    }

    // Only creator or project admin can delete a view
    if (existing.createdById !== userId && userRole !== 'admin') {
      throw new ForbiddenException(
        'Only the author or a project admin can delete this saved view',
      );
    }

    const deleted = await this.viewRepository.delete(viewId);

    if (deleted) {
      this.eventEmitter.emit('work-item.view.deleted', {
        viewId,
        projectId,
        actorId: userId,
        name: existing.name,
      });
    }

    return { success: deleted };
  }

  async toggleFavorite(
    projectId: string,
    viewId: string,
    userId: string,
    userRole?: string,
  ): Promise<{ isFavorite: boolean }> {
    // Assert view exists and caller can access it
    await this.getView(projectId, viewId, userId, userRole);
    return this.viewRepository.toggleFavorite(viewId, userId);
  }

  async favorite(
    projectId: string,
    viewId: string,
    userId: string,
    userRole?: string,
  ): Promise<{ isFavorite: boolean }> {
    await this.getView(projectId, viewId, userId, userRole);
    const isFavorited = await this.viewRepository.favorite(viewId, userId);
    return { isFavorite: isFavorited };
  }

  async getFavoriteViews(
    projectId: string,
    userId: string,
  ): Promise<any[]> {
    return this.viewRepository.findUserFavoriteViews(projectId, userId);
  }

  async unfavorite(
    projectId: string,
    viewId: string,
    userId: string,
    userRole?: string,
  ): Promise<{ isFavorite: boolean }> {
    await this.getView(projectId, viewId, userId, userRole);
    await this.viewRepository.unfavorite(viewId, userId);
    return { isFavorite: false };
  }

  async getViewWorkItems(
    projectId: string,
    viewId: string,
    userId: string,
    userRole?: string,
    extraQuery?: Partial<QueryWorkItemDto>,
  ): Promise<any> {
    const view = await this.getView(projectId, viewId, userId, userRole);
    const viewFilters = (view.query || {}) as Record<string, any>;

    // Merge view filters with any runtime override filters
    const mergedQuery: QueryWorkItemDto = {
      ...(viewFilters.status && { status: viewFilters.status }),
      ...(viewFilters.columnId && { status: viewFilters.columnId }),
      ...(viewFilters.assigneeId && { assigneeId: viewFilters.assigneeId }),
      ...(viewFilters.priority && { priority: viewFilters.priority }),
      ...(viewFilters.labels && {
        labels: Array.isArray(viewFilters.labels)
          ? viewFilters.labels
          : [viewFilters.labels],
      }),
      ...(viewFilters.cycleId && { cycleId: viewFilters.cycleId }),
      ...(viewFilters.search && { search: viewFilters.search }),
      ...(viewFilters.parentTaskId && { parentTaskId: viewFilters.parentTaskId }),
      ...(viewFilters.archived !== undefined && { archived: viewFilters.archived }),
      ...extraQuery,
    };

    return this.workItemService.getProjectTasks(projectId, mergedQuery);
  }
}
