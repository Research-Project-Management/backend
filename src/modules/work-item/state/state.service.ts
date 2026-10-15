import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core';
import { StateRepository } from './state.repository';
import {
  CreateStateDto,
  UpdateStateDto,
  ReorderStatesDto,
} from './dto/state.dto';
import {
  DEFAULT_WORK_ITEM_STATES,
  WorkItemState,
  getStateDefaultIcon,
} from './types/state.types';
import { generateStateSlug, isValidStateGroup } from './utils/state.util';
import { invalidateWorkItemCache } from '@/modules/work-item/common/constants/redis-keys.constant';

@Injectable()
export class StateService {
  constructor(
    private readonly stateRepository: StateRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async ensureProjectExists(projectId: string) {
    const project = await this.stateRepository.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  /**
   * Retrieves all states configured for a project, sorted by sequence ascending.
   * Returns both `states` and `columns` for full backwards compatibility.
   */
  async getStates(projectId: string): Promise<{
    states: WorkItemState[];
    columns: WorkItemState[];
  }> {
    await this.ensureProjectExists(projectId);
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
   * Returns a map of WorkItem counts grouped by stateId for a project.
   */
  async getStateWorkItemCounts(
    projectId: string,
  ): Promise<Record<string, number>> {
    await this.ensureProjectExists(projectId);
    return this.stateRepository.countWorkItemsByState(projectId);
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
    await this.ensureProjectExists(projectId);

    const existingStates =
      await this.stateRepository.findProjectStates(projectId);
    const targetName = (
      createStateDto.name ||
      createStateDto.title ||
      ''
    ).trim();

    if (!targetName) {
      throw new BadRequestException('State name cannot be empty');
    }

    const nameExists = existingStates.some(
      (state) => state.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (nameExists) {
      throw new BadRequestException(
        `State with name '${targetName}' already exists in this project`,
      );
    }

    let stateId = (createStateDto.id || generateStateSlug(targetName)).trim();
    if (!stateId) stateId = `state-${Date.now()}`;
    if (existingStates.some((state) => state.id === stateId)) {
      stateId = `${stateId}-${Date.now().toString().slice(-4)}`;
    }

    const maxSeq = existingStates.reduce(
      (maxSequence, state) => Math.max(maxSequence, state.sequence || 0),
      0,
    );
    const sequence =
      typeof createStateDto.sequence === 'number' &&
      !isNaN(createStateDto.sequence)
        ? createStateDto.sequence
        : maxSeq + 1000;

    const isDefault = Boolean(createStateDto.isDefault);
    const color = (
      createStateDto.color ||
      createStateDto.accentColor ||
      '#6366F1'
    ).trim();

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
      icon: (
        createStateDto.icon || getStateDefaultIcon(createStateDto.group)
      ).trim(),
      group: createStateDto.group,
      sequence,
      isDefault,
      description: createStateDto.description?.trim(),
    };

    updatedStates.push(newState);
    updatedStates.sort(
      (firstState, secondState) => firstState.sequence - secondState.sequence,
    );

    await this.stateRepository.saveProjectStates(projectId, updatedStates);
    await this.invalidateProjectStateCache(projectId);

    this.eventEmitter?.emit('state.created', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
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
   * - If group changes to/from completed, synchronizes work items
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
    await this.ensureProjectExists(projectId);

    const existingStates =
      await this.stateRepository.findProjectStates(projectId);
    const targetIndex = existingStates.findIndex(
      (state) => state.id === stateId,
    );
    if (targetIndex === -1) {
      throw new NotFoundException(`State with ID '${stateId}' not found`);
    }

    const current = existingStates[targetIndex];
    const newName = (
      updateStateDto.name ||
      updateStateDto.title ||
      current.name
    ).trim();

    if (newName.toLowerCase() !== current.name.toLowerCase()) {
      const duplicate = existingStates.some(
        (state) =>
          state.id !== stateId &&
          state.name.toLowerCase() === newName.toLowerCase(),
      );
      if (duplicate) {
        throw new BadRequestException(
          `State with name '${newName}' already exists in this project`,
        );
      }
    }

    if (updateStateDto.isDefault === false && current.isDefault) {
      throw new BadRequestException(
        'Cannot unset the default state directly. Please set another state as default instead.',
      );
    }

    const becomesDefault = updateStateDto.isDefault === true;
    const newGroup =
      updateStateDto.group && isValidStateGroup(updateStateDto.group)
        ? updateStateDto.group
        : current.group;
    const newColor = (
      updateStateDto.color ||
      updateStateDto.accentColor ||
      current.color
    ).trim();
    const newSequence =
      typeof updateStateDto.sequence === 'number' &&
      !isNaN(updateStateDto.sequence)
        ? updateStateDto.sequence
        : current.sequence;
    const newDescription =
      updateStateDto.description !== undefined
        ? updateStateDto.description.trim()
        : current.description;
    const newIcon = (
      updateStateDto.icon ||
      current.icon ||
      getStateDefaultIcon(newGroup)
    ).trim();

    const updatedStates = existingStates.map((state) => {
      if (state.id === stateId) {
        return {
          ...state,
          name: newName,
          title: newName,
          color: newColor,
          accentColor: newColor,
          icon: newIcon,
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

    updatedStates.sort(
      (firstState, secondState) => firstState.sequence - secondState.sequence,
    );

    const previousWasCompleted = current.group === 'completed';
    const nowIsCompleted = newGroup === 'completed';
    if (previousWasCompleted !== nowIsCompleted) {
      await this.stateRepository.migrateWorkItemsToState(
        projectId,
        stateId,
        stateId,
        nowIsCompleted,
      );
    }

    await this.stateRepository.saveProjectStates(projectId, updatedStates);
    await this.invalidateProjectStateCache(projectId);

    const updatedState = updatedStates.find((state) => state.id === stateId)!;

    this.eventEmitter?.emit('state.updated', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
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
   * 3. Cannot delete a state containing work items without specifying a fallback target state.
   * 4. Atomic migration of work items to fallback state with completion status synchronization.
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
    await this.ensureProjectExists(projectId);

    const currentStates =
      await this.stateRepository.findProjectStates(projectId);
    const stateToDelete = currentStates.find((state) => state.id === stateId);
    if (!stateToDelete) {
      throw new NotFoundException(`State ${stateId} not found in project`);
    }

    if (currentStates.length <= 1) {
      throw new BadRequestException(
        'Cannot delete the only state in the project. Projects must have at least one state.',
      );
    }

    if (stateToDelete.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default state. Mark another state as default first.',
      );
    }

    const remainingStates = currentStates.filter(
      (state) => state.id !== stateId,
    );

    const workItemCount = await this.stateRepository.countWorkItemsInState(
      projectId,
      stateId,
    );

    let targetFallbackId: string;
    let isFallbackCompleted = false;

    if (workItemCount > 0) {
      if (!fallbackStateId) {
        throw new BadRequestException(
          `State "${stateToDelete.name}" has ${workItemCount} WorkItem(s). You must specify a fallback state to reassign them to.`,
        );
      }
      const fallbackTarget = remainingStates.find(
        (state) => state.id === fallbackStateId,
      );
      if (!fallbackTarget) {
        throw new BadRequestException(
          `Fallback state ${fallbackStateId} does not exist in remaining project states`,
        );
      }
      targetFallbackId = fallbackStateId;
      isFallbackCompleted = fallbackTarget.group === 'completed';
    } else {
      targetFallbackId = remainingStates[0].id;
      isFallbackCompleted = remainingStates[0].group === 'completed';
    }

    await this.stateRepository.deleteStateWithWorkItemMigration(
      projectId,
      stateId,
      targetFallbackId,
      remainingStates,
      isFallbackCompleted,
    );

    await this.invalidateProjectStateCache(projectId);

    this.eventEmitter?.emit('state.deleted', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      projectId,
    });

    return {
      states: remainingStates,
      columns: remainingStates,
      migratedTo: workItemCount > 0 ? targetFallbackId : undefined,
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
    await this.ensureProjectExists(projectId);

    const items = reorderStatesDto.states || reorderStatesDto.columns;
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('States list cannot be empty');
    }

    const currentStates =
      await this.stateRepository.findProjectStates(projectId);
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

    let nextSeq = (reordered.length + 1) * 1000;
    for (const remaining of stateMap.values()) {
      reordered.push({ ...remaining, sequence: nextSeq });
      nextSeq += 1000;
    }

    reordered.sort(
      (firstState, secondState) => firstState.sequence - secondState.sequence,
    );

    await this.stateRepository.saveProjectStates(projectId, reordered);
    await this.invalidateProjectStateCache(projectId);

    this.eventEmitter?.emit('state.reordered', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
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
    await this.ensureProjectExists(projectId);

    const defaultStates = [...DEFAULT_WORK_ITEM_STATES];

    await this.stateRepository.deleteStateWithWorkItemMigration(
      projectId,
      '__orphan_migration__',
      'backlog',
      defaultStates,
      false,
    );

    await this.invalidateProjectStateCache(projectId);

    this.eventEmitter?.emit('state.reset', {
      entityType: 'project',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      projectId,
    });

    return { states: defaultStates, columns: defaultStates };
  }

  private async invalidateProjectStateCache(projectId: string): Promise<void> {
    if (!this.cache) return;
    await invalidateWorkItemCache(this.cache, { projectId });
    await Promise.allSettled([
      this.cache.del(`flux:project:${projectId}`),
      this.cache.del(`flux:project:overview:${projectId}`),
    ]);
  }
}
