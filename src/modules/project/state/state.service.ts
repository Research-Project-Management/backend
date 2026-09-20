import {
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectState, EntityType } from '@prisma/client';
import { StateRepository } from './state.repository';
import { DEFAULT_PROJECT_STATES, DefaultProjectStateTemplate } from './state.constants';
import { ProjectCurrentStateResponseDto } from './dto/project-state-response.dto';
import {
  CreateProjectStateDto,
  UpdateProjectStateItemDto,
  ReorderProjectStatesDto,
} from './dto/project-state.dto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CACHE_KEYS } from '@/modules/project/core/constants/cache.constant';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

@Injectable()
export class StateService {
  constructor(
    private readonly stateRepo: StateRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * Get default template states to suggest when users want to reset or initialize.
   */
  getDefaultStatesTemplate(): DefaultProjectStateTemplate[] {
    return DEFAULT_PROJECT_STATES;
  }

  /**
   * Retrieve all states configured for a project (ordered by sequence).
   * Returns empty array [] if user deleted all states.
   */
  async getProjectStates(projectId: string): Promise<ProjectState[]> {
    return this.stateRepo.findProjectStates(projectId);
  }

  /**
   * Get the current state details for a project.
   * Gracefully handles NULL state when user has deleted all states or unassigned state.
   */
  async getProjectCurrentState(
    projectId: string,
  ): Promise<ProjectCurrentStateResponseDto> {
    const project = await this.stateRepo.findProjectState(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (!project.stateId || !project.state) {
      return {
        projectId: project.id,
        stateId: null,
        state: null,
        stateLabel: 'Chưa đặt trạng thái (Unassigned)',
      };
    }

    return {
      projectId: project.id,
      stateId: project.stateId,
      state: project.state,
      stateLabel: project.state.name,
    };
  }

  /**
   * Create a new custom state for a project.
   */
  async createCustomState(
    projectId: string,
    dto: CreateProjectStateDto,
    actorId?: string,
  ): Promise<ProjectState> {
    const created = await this.stateRepo.createProjectState(projectId, dto);
    await this.invalidateProjectCache(projectId);

    this.eventEmitter?.emit(
      'project.state.created',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'project_state_created',
        field: 'state',
        newValue: created.name,
        actorId: actorId || '',
        projectId,
      }),
    );

    return created;
  }

  /**
   * Update an existing state (name, color, description, sequence).
   */
  async updateCustomState(
    projectId: string,
    stateId: string,
    dto: UpdateProjectStateItemDto,
    actorId?: string,
  ): Promise<ProjectState> {
    const existing = await this.stateRepo.findProjectStateById(projectId, stateId);
    if (!existing) {
      throw new NotFoundException(`Trạng thái với ID "${stateId}" không tồn tại trong dự án`);
    }

    const updated = await this.stateRepo.updateProjectStateItem(projectId, stateId, dto);
    await this.invalidateProjectCache(projectId);

    this.eventEmitter?.emit(
      'project.state.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'project_state_updated',
        field: 'state',
        oldValue: existing.name,
        newValue: updated.name,
        actorId: actorId || '',
        projectId,
      }),
    );

    return updated;
  }

  /**
   * Drag & drop reorder: update sequence positions of project's states.
   */
  async reorderStates(
    projectId: string,
    dto: ReorderProjectStatesDto,
    actorId?: string,
  ): Promise<ProjectState[]> {
    const reordered = await this.stateRepo.reorderProjectStates(projectId, dto.states);
    await this.invalidateProjectCache(projectId);

    this.eventEmitter?.emit(
      'project.states.reordered',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'project_states_reordered',
        field: 'sequence',
        actorId: actorId || '',
        projectId,
      }),
    );

    return reordered;
  }

  /**
   * Delete a state permanently.
   * If all states deleted, project state becomes null.
   */
  async deleteCustomState(
    projectId: string,
    stateId: string,
    fallbackStateId?: string,
    actorId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const state = await this.stateRepo.findProjectStateById(projectId, stateId);
    if (!state) {
      throw new NotFoundException(`Trạng thái với ID "${stateId}" không tồn tại`);
    }

    await this.stateRepo.deleteProjectState(projectId, stateId, fallbackStateId);
    await this.invalidateProjectCache(projectId);

    this.eventEmitter?.emit(
      'project.state.deleted',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'project_state_deleted',
        field: 'state',
        oldValue: state.name,
        actorId: actorId || '',
        projectId,
      }),
    );

    return { success: true, message: `Đã xóa trạng thái "${state.name}" thành công` };
  }

  /**
   * Transition project to a target custom state (or null to unassign).
   */
  async transitionToState(
    projectId: string,
    targetStateId: string | null,
    actorId?: string,
  ): Promise<ProjectCurrentStateResponseDto> {
    const project = await this.stateRepo.findProjectState(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (!targetStateId) {
      await this.stateRepo.setCurrentProjectState(projectId, null);
      await this.invalidateProjectCache(projectId);
      return {
        projectId: project.id,
        stateId: null,
        state: null,
        stateLabel: 'Chưa đặt trạng thái (Unassigned)',
      };
    }

    const targetState = await this.stateRepo.findProjectStateById(projectId, targetStateId);
    if (!targetState) {
      throw new NotFoundException(`Trạng thái mục tiêu với ID "${targetStateId}" không tồn tại trong dự án`);
    }

    await this.stateRepo.setCurrentProjectState(projectId, targetStateId);
    await this.invalidateProjectCache(projectId);

    this.eventEmitter?.emit(
      'project.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'state_changed',
        field: 'state',
        oldValue: project.state?.name ?? '',
        newValue: targetState.name,
        actorId: actorId || '',
        projectId,
      }),
    );

    return {
      projectId: project.id,
      stateId: targetState.id,
      state: targetState,
      stateLabel: targetState.name,
    };
  }

  /**
   * Best-effort cache invalidation after state change.
   */
  private async invalidateProjectCache(projectId: string): Promise<void> {
    if (!this.cache) return;
    try {
      await Promise.all([
        this.cache.del(CACHE_KEYS.detail(projectId)),
        this.cache.del(CACHE_KEYS.overview(projectId)),
      ]);
    } catch {
      // Best effort
    }
  }
}

