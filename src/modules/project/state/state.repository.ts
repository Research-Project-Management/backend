import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Project, ProjectState } from '@prisma/client';
import { DEFAULT_PROJECT_STATES } from './state.constants';
import {
  CreateProjectStateDto,
  UpdateProjectStateItemDto,
  ReorderProjectStateItemDto,
} from './dto/project-state.dto';

@Injectable()
export class StateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find project's current state and active state record.
   */
  async findProjectState(projectId: string): Promise<{
    id: string;
    name: string;
    stateId: string | null;
    state: ProjectState | null;
  } | null> {
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        name: true,
        stateId: true,
        state: true,
      },
    });
  }

  /**
   * Seed the 8 default research states for a project.
   */
  async seedDefaultProjectStates(
    projectId: string,
  ): Promise<ProjectState[]> {
    const existing = await this.prisma.projectState.findMany({
      where: { projectId },
      orderBy: { sequence: 'asc' },
    });

    if (existing.length > 0) {
      return existing;
    }

    const createdStates: ProjectState[] = [];
    for (const tpl of DEFAULT_PROJECT_STATES) {
      const state = await this.prisma.projectState.create({
        data: {
          projectId,
          name: tpl.name,
          description: tpl.description,
          color: tpl.color,
          sequence: tpl.sequence,
          isDefault: tpl.isDefault,
        },
      });
      createdStates.push(state);
    }

    // Set initial stateId on Project
    const defaultState =
      createdStates.find((s) => s.isDefault) || createdStates[0];
    if (defaultState) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          stateId: defaultState.id,
        },
      });
    }

    return createdStates;
  }

  /**
   * Retrieve all states configured for a project, sorted by sequence ascending.
   * If user has deleted all states, returns empty array [] without re-seeding.
   */
  async findProjectStates(
    projectId: string,
  ): Promise<ProjectState[]> {
    return this.prisma.projectState.findMany({
      where: { projectId },
      orderBy: { sequence: 'asc' },
    });
  }

  /**
   * Find a specific state by its ID within a project.
   */
  async findProjectStateById(
    projectId: string,
    stateId: string,
  ): Promise<ProjectState | null> {
    return this.prisma.projectState.findFirst({
      where: { id: stateId, projectId },
    });
  }

  /**
   * Create a new custom state for a project.
   */
  async createProjectState(
    projectId: string,
    dto: CreateProjectStateDto,
  ): Promise<ProjectState> {
    let sequence = dto.sequence;
    if (sequence === undefined) {
      const last = await this.prisma.projectState.findFirst({
        where: { projectId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      sequence = (last?.sequence ?? -1) + 1;
    }

    if (dto.isDefault) {
      await this.prisma.projectState.updateMany({
        where: { projectId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const created = await this.prisma.projectState.create({
      data: {
        projectId,
        name: dto.name.trim(),
        description: dto.description?.trim() || '',
        color: dto.color || '#0284c7',
        sequence,
        isDefault: dto.isDefault ?? false,
      },
    });

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { stateId: true },
    });
    if (!project?.stateId || dto.isDefault) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          stateId: created.id,
        },
      });
    }

    return created;
  }

  /**
   * Update an existing state (name, color, description, sequence).
   */
  async updateProjectStateItem(
    projectId: string,
    stateId: string,
    dto: UpdateProjectStateItemDto,
  ): Promise<ProjectState> {
    if (dto.isDefault) {
      await this.prisma.projectState.updateMany({
        where: { projectId, isDefault: true, id: { not: stateId } },
        data: { isDefault: false },
      });
    }

    return this.prisma.projectState.update({
      where: { id: stateId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.description !== undefined && {
          description: dto.description.trim(),
        }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.sequence !== undefined && { sequence: dto.sequence }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
      },
    });
  }

  /**
   * Drag & drop reorder: atomically update sequence of multiple states in a transaction.
   */
  async reorderProjectStates(
    projectId: string,
    items: ReorderProjectStateItemDto[],
  ): Promise<ProjectState[]> {
    await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.projectState.updateMany({
          where: { id: item.id, projectId },
          data: { sequence: item.sequence },
        }),
      ),
    );

    return this.findProjectStates(projectId);
  }

  /**
   * Delete a state permanently.
   * If project is currently at this state:
   * - Migrate to fallbackStateId if provided
   * - Otherwise migrate to another remaining state
   * - If NO remaining states exist (user deleted all states), sets project.stateId = null.
   */
  async deleteProjectState(
    projectId: string,
    stateId: string,
    fallbackStateId?: string,
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { stateId: true },
    });

    if (project?.stateId === stateId) {
      let targetId = fallbackStateId;
      if (!targetId) {
        const nextAvailable = await this.prisma.projectState.findFirst({
          where: { projectId, id: { not: stateId } },
          orderBy: { sequence: 'asc' },
        });
        targetId = nextAvailable?.id;
      }

      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          stateId: targetId ?? null,
        },
      });
    }

    await this.prisma.projectState.delete({
      where: { id: stateId },
    });
  }

  /**
   * Set project's current state to a specific state record or null.
   */
  async setCurrentProjectState(
    projectId: string,
    stateId: string | null,
  ): Promise<Project> {
    return this.prisma.project.update({
      where: { id: projectId, deletedAt: null },
      data: {
        stateId,
      },
    });
  }
}

