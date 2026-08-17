import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ProjectRepository } from './project.repository';
import { Prisma, ProjectMemberRole } from '@prisma/client';
import { parseTaskColumns, TaskColumn } from '@/core/types/json-fields.type';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddProjectMemberDto,
  UpdateProjectMemberDto,
  AddColumnDto,
  UpdateColumnDto,
} from './dto/project.dto';

const VALID_PROJECT_ROLES = new Set<string>(Object.values(ProjectMemberRole));

@Injectable()
export class ProjectService {
  constructor(private readonly projectRepo: ProjectRepository) {}

  async getProjects(workspaceId: string) {
    const projects = await this.projectRepo.findWorkspaceProjects(workspaceId);
    return { projects };
  }

  async getProject(projectId: string, userId?: string) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const member = userId
      ? project.members.find((m) => m.userId === userId)
      : undefined;

    return {
      project,
      yourRole: member?.role || ProjectMemberRole.viewer,
    };
  }

  async createProject(
    workspaceId: string,
    userId: string,
    dto: CreateProjectDto,
  ) {
    const targetWorkspaceId = workspaceId || dto.workspaceId;
    if (!targetWorkspaceId) {
      throw new BadRequestException('Workspace ID is required');
    }

    const ws = await this.projectRepo.resolveWorkspace(targetWorkspaceId);
    const resolvedWorkspaceId = ws?.id || targetWorkspaceId;

    const project = await this.projectRepo.createProject({
      name: dto.name,
      avatar: dto.avatar || '',
      description: dto.description || '',
      modules: dto.modules || [
        'overview',
        'tasks',
        'cycles',
        'pages',
        'storage',
        'stickies',
        'collection',
      ],
      workspaceId: resolvedWorkspaceId,
      createdById: userId,
      members: {
        create: {
          userId,
          role: ProjectMemberRole.admin,
        },
      },
    });

    return { project };
  }

  async updateProject(projectId: string, dto: UpdateProjectDto) {
    const project = await this.projectRepo.updateProject(projectId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.modules !== undefined && { modules: dto.modules }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      ...(dto.settings !== undefined && { settings: dto.settings }),
    });

    return { project };
  }

  async deleteProject(projectId: string) {
    await this.projectRepo.updateProject(projectId, { isActive: false });
    return { message: 'Project deleted successfully' };
  }

  async getProjectMembers(projectId: string) {
    const members = await this.projectRepo.findProjectMembers(projectId);
    return { members };
  }

  async addProjectMember(projectId: string, dto: AddProjectMemberDto) {
    const existing = await this.projectRepo.findProjectMember(
      projectId,
      dto.userId,
    );

    if (existing) {
      throw new BadRequestException('User is already a member of this project');
    }

    const role = dto.role || ProjectMemberRole.contributor;
    if (!VALID_PROJECT_ROLES.has(role)) {
      throw new BadRequestException(
        `Invalid project role "${role}". Valid roles are: ${Object.values(ProjectMemberRole).join(', ')}`,
      );
    }

    const member = await this.projectRepo.createProjectMember(
      projectId,
      dto.userId,
      role,
    );

    return {
      message: 'Project member added successfully',
      member,
    };
  }

  async updateProjectMember(
    projectId: string,
    targetUserId: string,
    dto: UpdateProjectMemberDto,
  ) {
    if (!VALID_PROJECT_ROLES.has(dto.role)) {
      throw new BadRequestException(
        `Invalid project role "${dto.role}". Valid roles are: ${Object.values(ProjectMemberRole).join(', ')}`,
      );
    }

    const member = await this.projectRepo.updateProjectMemberRole(
      projectId,
      targetUserId,
      dto.role,
    );

    return {
      message: 'Project member role updated successfully',
      member,
    };
  }

  async removeProjectMember(projectId: string, targetUserId: string) {
    await this.projectRepo.deleteProjectMember(projectId, targetUserId);
    return { message: 'Project member removed successfully' };
  }

  async addColumn(projectId: string, dto: AddColumnDto) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(project.taskColumns);
    const newColumn: TaskColumn = {
      id: dto.id || dto.title.toLowerCase().replace(/\s+/g, '-'),
      title: dto.title,
      isDefault: false,
      accentColor: dto.accentColor || '#6366F1',
    };

    const updatedColumns = [...columns, newColumn];

    await this.projectRepo.updateProject(projectId, {
      taskColumns: updatedColumns as unknown as Prisma.InputJsonValue,
    });

    return { columns: updatedColumns };
  }

  async updateColumn(
    projectId: string,
    columnId: string,
    dto: UpdateColumnDto,
  ) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(project.taskColumns);
    const updatedColumns = columns.map((col) => {
      if (col.id === columnId) {
        return {
          ...col,
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.accentColor !== undefined && {
            accentColor: dto.accentColor,
          }),
        };
      }
      return col;
    });

    await this.projectRepo.updateProject(projectId, {
      taskColumns: updatedColumns as unknown as Prisma.InputJsonValue,
    });

    return { columns: updatedColumns };
  }

  async deleteColumn(projectId: string, columnId: string) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(project.taskColumns);
    const updatedColumns = columns.filter((col) => col.id !== columnId);

    await this.projectRepo.updateProject(projectId, {
      taskColumns: updatedColumns as unknown as Prisma.InputJsonValue,
    });

    return { columns: updatedColumns };
  }

  async getProjectOverview(projectId: string, _userId?: string) {
    const overview = await this.projectRepo.findProjectOverview(projectId);
    if (!overview) {
      throw new NotFoundException('Project not found');
    }
    return overview;
  }
}

