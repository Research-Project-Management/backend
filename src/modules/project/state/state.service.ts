import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ProjectState } from '@prisma/client';
import { StateRepository } from './state.repository';
import {
  PROJECT_STATES_CATALOG,
  ALLOWED_STATE_TRANSITIONS,
  ProjectStateMetadata,
} from './state.constants';
import { ProjectCurrentStateResponseDto } from './dto/project-state-response.dto';

@Injectable()
export class StateService {
  constructor(private readonly stateRepo: StateRepository) {}

  /**
   * Get list of all available project states with their metadata.
   */
  getProjectStatesCatalog(): ProjectStateMetadata[] {
    return PROJECT_STATES_CATALOG;
  }

  /**
   * Get the current state and allowed transitions for a project.
   */
  async getProjectCurrentState(
    projectId: string,
  ): Promise<ProjectCurrentStateResponseDto> {
    const project = await this.stateRepo.findProjectState(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const stateMeta = PROJECT_STATES_CATALOG.find(
      (s) => s.state === project.state,
    );
    const allowedTransitions = ALLOWED_STATE_TRANSITIONS[project.state] || [];

    return {
      projectId: project.id,
      state: project.state,
      stateLabel: stateMeta?.label || project.state,
      allowedTransitions,
    };
  }

  /**
   * Transition a project to a new lifecycle state with transition validation.
   */
  async updateProjectState(
    projectId: string,
    targetState: ProjectState,
  ): Promise<ProjectCurrentStateResponseDto> {
    const project = await this.stateRepo.findProjectState(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (project.state === targetState) {
      return this.getProjectCurrentState(projectId);
    }

    const allowed = ALLOWED_STATE_TRANSITIONS[project.state] || [];
    if (!allowed.includes(targetState)) {
      throw new BadRequestException(
        `Invalid state transition: Cannot transition project "${project.name}" from "${project.state}" to "${targetState}". Allowed transitions: ${allowed.join(', ')}`,
      );
    }

    const updated = await this.stateRepo.updateProjectState(
      projectId,
      targetState,
    );
    const stateMeta = PROJECT_STATES_CATALOG.find(
      (s) => s.state === targetState,
    );
    const allowedTransitions = ALLOWED_STATE_TRANSITIONS[targetState] || [];

    return {
      projectId: updated.id,
      state: updated.state,
      stateLabel: stateMeta?.label || updated.state,
      allowedTransitions,
    };
  }
}
