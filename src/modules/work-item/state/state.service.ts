import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { StateRepository } from './state.repository';
import {
  CreateStateDto,
  UpdateStateDto,
  ReorderStatesDto,
} from './dto/state.dto';
import { DEFAULT_WORK_ITEM_STATES, WorkItemState } from './types/state.types';
import {
  generateStateSlug,
  isStateCompleted,
  isValidStateGroup,
} from './utils/state.util';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class StateService {
  constructor(
    private readonly stateRepository: StateRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * Retrieves all states configured for a project, sorted by sequence ascending.
   * Returns both `states` and `columns` for full backwards compatibility.
   */
  async getStates(projectId: string): Promise<{
    states: WorkItemState[];
    columns: WorkItemState[];
  }> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const states = await this.stateRepository.findProjectStates(projectId);
    return { states, columns: states };
  }

  /**
   * Retrieves a specific state by its ID within a project.
   */
  async getStateById(
    projectId: string,
    stateId: string,
  ): Promise<WorkItemState> {
    const { states } = await this.getStates(projectId);
    const state = states.find((state) => state.id === stateId);
    if (!state) {
      throw new NotFoundException(`State with ID '${stateId}' not found`);
    }
    return state;
  }

  /**
   * Returns a map of task counts grouped by stateId for a project.
   */
  async getStateTaskCounts(projectId: string): Promise<Record<string, number>> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return this.stateRepository.countTasksByState(projectId);
  }

  /**
   * Creates a new state:
   * - Name uniqueness within project
   * - Group validation
   * - Sequence calculation
   * - Default state uniqueness
   */
  async createState(
    projectId: string,
    createStateDto: CreateStateDto,
    userId?: string,
  ): Promise<{
    state: WorkItemState;
    states: WorkItemState[];
    columns: WorkItemState[];
  }> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const existingStates = await this.stateRepository.findProjectStates(projectId);
    const targetName = (createStateDto.name || createStateDto.title || '').trim();

    if (!targetName) {
      throw new BadRequestException('State name cannot be empty');
    }

    // Check name uniqueness (case-insensitive)
    const nameExists = existingStates.some(
      (state) => state.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (nameExists) {
      throw new BadRequestException(
        `State with name '${targetName}' already exists in this project`,
      );
    }

    // Generate unique slug id
    let stateId = (createStateDto.id || generateStateSlug(targetName)).trim();
    if (!stateId) stateId = `state-${Date.now()}`;
    if (existingStates.some((state) => state.id === stateId)) {
      stateId = `${stateId}-${Date.now().toString().slice(-4)}`;
    }

    // Determine sequence
    const maxSeq = existingStates.reduce(
      (maxSequence, state) => Math.max(maxSequence, state.sequence || 0),
      0,
    );
    const sequence =
      typeof createStateDto.sequence === 'number' && !isNaN(createStateDto.sequence)
        ? createStateDto.sequence
        : maxSeq + 1000;

    const isDefault = Boolean(createStateDto.isDefault);
    const color = (createStateDto.color || createStateDto.accentColor || '#6366F1').trim();

    // If new state is marked as default, unset previous default
    const updatedStates = existingStates.map((state) => {
      if (isDefault && state.isDefault) {
        return { ...state, isDefault: false };
      }
      return state;
    });

    const newState: WorkItemState = {
      id: stateId,
      name: targetName,
      title: targetName,
      color,
      accentColor: color,
      group: createStateDto.group,
      sequence,
      isDefault,
      description: createStateDto.description?.trim(),
    };

    updatedStates.push(newState);
    updatedStates.sort((firstState, secondState) => firstState.sequence - secondState.sequence);

    await this.stateRepository.saveProjectStates(projectId, updatedStates);
    await this.invalidateProjectStateCache(projectId, project.workspaceId);

    this.eventEmitter?.emit('state.created', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      workspaceId: project.workspaceId,
      projectId,
    });

    return {
      state: newState,
      states: updatedStates,
      columns: updatedStates,
    };
  }

  /**
   * Updates an existing state:
   * - Cannot unset default state without setting another
   * - Name uniqueness
   * - If group changes to/from completed, synchronizes tasks
   */
  async updateState(
    projectId: string,
    stateId: string,
    updateStateDto: UpdateStateDto,
    userId?: string,
  ): Promise<{
    state: WorkItemState;
    states: WorkItemState[];
    columns: WorkItemState[];
  }> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const existingStates = await this.stateRepository.findProjectStates(projectId);
    const targetIndex = existingStates.findIndex((state) => state.id === stateId);
    if (targetIndex === -1) {
      throw new NotFoundException(`State with ID '${stateId}' not found`);
    }

    const current = existingStates[targetIndex];
    const newName = (updateStateDto.name || updateStateDto.title || current.name).trim();

    // Check name uniqueness if changed
    if (newName.toLowerCase() !== current.name.toLowerCase()) {
      const duplicate = existingStates.some(
        (state) =>
          state.id !== stateId && state.name.toLowerCase() === newName.toLowerCase(),
      );
      if (duplicate) {
        throw new BadRequestException(
          `State with name '${newName}' already exists in this project`,
        );
      }
    }

    // Default state protection
    if (updateStateDto.isDefault === false && current.isDefault) {
      throw new BadRequestException(
        'Cannot unset the default state directly. Please set another state as default instead.',
      );
    }

    const becomesDefault = updateStateDto.isDefault === true;
    const newGroup =
      updateStateDto.group && isValidStateGroup(updateStateDto.group) ? updateStateDto.group : current.group;
    const newColor = (updateStateDto.color || updateStateDto.accentColor || current.color).trim();
    const newSequence =
      typeof updateStateDto.sequence === 'number' && !isNaN(updateStateDto.sequence)
        ? updateStateDto.sequence
        : current.sequence;
    const newDescription =
      updateStateDto.description !== undefined
        ? updateStateDto.description.trim()
        : current.description;

    const updatedStates = existingStates.map((state) => {
      if (state.id === stateId) {
        return {
          ...state,
          name: newName,
          title: newName,
          color: newColor,
          accentColor: newColor,
          group: newGroup,
          sequence: newSequence,
          isDefault: becomesDefault || state.isDefault,
          description: newDescription,
        };
      }
      if (becomesDefault && state.isDefault) {
        return { ...state, isDefault: false };
      }
      return state;
    });

    updatedStates.sort((firstState, secondState) => firstState.sequence - secondState.sequence);

    // If group changed to or from completed, synchronize completion on existing tasks in this state
    const previousWasCompleted = current.group === 'completed';
    const nowIsCompleted = newGroup === 'completed';
    if (previousWasCompleted !== nowIsCompleted) {
      await this.stateRepository.migrateTasksToState(
        projectId,
        stateId,
        stateId,
        nowIsCompleted,
      );
    }

    await this.stateRepository.saveProjectStates(projectId, updatedStates);
    await this.invalidateProjectStateCache(projectId, project.workspaceId);

    const updatedState = updatedStates.find((state) => state.id === stateId)!;

    this.eventEmitter?.emit('state.updated', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      workspaceId: project.workspaceId,
      projectId,
    });

    return {
      state: updatedState,
      states: updatedStates,
      columns: updatedStates,
    };
  }

  /**
   * Deletes a state following safe deletion rules:
   * 1. Cannot delete the only remaining state in a project.
   * 2. Cannot delete the default state.
   * 3. Cannot delete a state containing tasks without specifying a fallback target state.
   * 4. Atomic migration of tasks to fallback state with completion status synchronization.
   */
  async deleteState(
    projectId: string,
    stateId: string,
    fallbackStateId?: string,
    userId?: string,
  ): Promise<{
    states: WorkItemState[];
    columns: WorkItemState[];
    migratedTo?: string;
  }> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const states = await this.stateRepository.findProjectStates(projectId);
    const targetState = states.find((state) => state.id === stateId);
    if (!targetState) {
      throw new NotFoundException(`State with ID '${stateId}' not found`);
    }

    // Rule 1: Project must have at least one state
    if (states.length <= 1) {
      throw new BadRequestException('Project must have at least one state');
    }

    // Rule 2: Cannot delete the default state
    if (targetState.isDefault) {
      throw new BadRequestException(
        'Cannot delete default state. Mark another state as default first.',
      );
    }

    const taskCount = await this.stateRepository.countTasksInState(
      projectId,
      stateId,
    );

    // Rule 3: If tasks exist, a valid fallback state is required
    const remainingStates = states.filter((state) => state.id !== stateId);
    let resolvedFallback: WorkItemState | undefined;

    if (taskCount > 0) {
      if (!fallbackStateId) {
        throw new BadRequestException(
          `Cannot delete state '${targetState.name}' because it contains ${taskCount} active work item(s). Please choose a target state to move them to.`,
        );
      }

      resolvedFallback = remainingStates.find((state) => state.id === fallbackStateId);
      if (!resolvedFallback) {
        throw new BadRequestException(
          `Target fallback state '${fallbackStateId}' does not exist in this project`,
        );
      }
    } else if (fallbackStateId) {
      resolvedFallback = remainingStates.find((state) => state.id === fallbackStateId);
    }

    // If fallback is needed, check its completion group
    const isFallbackCompleted = resolvedFallback
      ? isStateCompleted(resolvedFallback)
      : false;

    const targetFallbackId = resolvedFallback?.id || remainingStates[0].id;

    await this.stateRepository.deleteStateWithTaskMigration(
      projectId,
      stateId,
      targetFallbackId,
      remainingStates,
      isFallbackCompleted,
    );

    await this.invalidateProjectStateCache(projectId, project.workspaceId);

    this.eventEmitter?.emit('state.deleted', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      workspaceId: project.workspaceId,
      projectId,
    });

    return {
      states: remainingStates,
      columns: remainingStates,
      migratedTo: taskCount > 0 ? targetFallbackId : undefined,
    };
  }

  /**
   * Reorders project states and optionally updates group assignments.
   */
  async reorderStates(
    projectId: string,
    reorderStatesDto: ReorderStatesDto,
    userId?: string,
  ): Promise<{
    states: WorkItemState[];
    columns: WorkItemState[];
  }> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const items = reorderStatesDto.states || reorderStatesDto.columns;
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('States list cannot be empty');
    }

    const currentStates = await this.stateRepository.findProjectStates(projectId);
    const stateMap = new Map(currentStates.map((state) => [state.id, state]));

    const reordered: WorkItemState[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const existing = stateMap.get(item.id);
      if (!existing) continue;

      const sequence =
        typeof item.sequence === 'number' ? item.sequence : (index + 1) * 1000;
      const group =
        item.group && isValidStateGroup(item.group)
          ? item.group
          : existing.group;

      reordered.push({
        ...existing,
        sequence,
        group,
        title: item.title?.trim() || existing.name,
        name: item.title?.trim() || existing.name,
        color: item.accentColor?.trim() || existing.color,
        accentColor: item.accentColor?.trim() || existing.color,
      });
      stateMap.delete(item.id);
    }

    // Append any states that were not mentioned in reorder list
    let nextSeq = (reordered.length + 1) * 1000;
    for (const remaining of stateMap.values()) {
      reordered.push({ ...remaining, sequence: nextSeq });
      nextSeq += 1000;
    }

    reordered.sort((firstState, secondState) => firstState.sequence - secondState.sequence);

    await this.stateRepository.saveProjectStates(projectId, reordered);
    await this.invalidateProjectStateCache(projectId, project.workspaceId);

    this.eventEmitter?.emit('state.reordered', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      workspaceId: project.workspaceId,
      projectId,
    });

    return { states: reordered, columns: reordered };
  }

  /**
   * Resets the project states to the 5 default preset states:
   * Backlog, To Do, In Progress, Done, Cancelled.
   */
  async resetToDefaultStates(
    projectId: string,
    userId?: string,
  ): Promise<{
    states: WorkItemState[];
    columns: WorkItemState[];
  }> {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const defaultStates = [...DEFAULT_WORK_ITEM_STATES];
    const defaultIds = new Set(defaultStates.map((state) => state.id));

    // Migrate any orphan tasks whose columnId does not match any default state to 'backlog'
    await this.stateRepository.deleteStateWithTaskMigration(
      projectId,
      '__orphan_migration__',
      'backlog',
      defaultStates,
      false,
    );

    await this.invalidateProjectStateCache(projectId, project.workspaceId);

    this.eventEmitter?.emit('state.reset', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      workspaceId: project.workspaceId,
      projectId,
    });

    return { states: defaultStates, columns: defaultStates };
  }

  private async invalidateProjectStateCache(
    projectId: string,
    workspaceId: string,
  ): Promise<void> {
    if (!this.cache) return;
    await Promise.allSettled([
      this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)),
      this.cache.del(`flux:project:${projectId}`),
      this.cache.del(`flux:project:overview:${projectId}`),
    ]);
  }
}
