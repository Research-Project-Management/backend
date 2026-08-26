/**
 * Project Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import {
  Project,
  ProjectMember,
  ProjectMemberRole,
  Prisma,
} from '@prisma/client';

export const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type ProjectWithMembers = Prisma.ProjectGetPayload<{
  include: {
    members: {
      include: {
        user: { select: typeof USER_SELECT };
      };
    };
    lead: { select: typeof USER_SELECT };
  };
}> & {
  workspace?: {
    id: string;
    name: string;
    url: string;
  };
};

export interface IProjectRepository {
  resolveWorkspace(workspaceIdOrSlug: string): Promise<{ id: string } | null>;
  findWorkspaceProjects(workspaceId: string): Promise<ProjectWithMembers[]>;
  findProjectById(projectId: string): Promise<ProjectWithMembers | null>;
  findProjectByIdentifier(
    workspaceId: string,
    identifier: string,
  ): Promise<ProjectWithMembers | null>;

  createProject(
    data: Prisma.ProjectCreateInput | Prisma.ProjectUncheckedCreateInput,
  ): Promise<ProjectWithMembers>;

  updateProject(
    projectId: string,
    data: Prisma.ProjectUpdateInput | Prisma.ProjectUncheckedUpdateInput,
  ): Promise<ProjectWithMembers>;

  softDeleteProject(projectId: string): Promise<Project>;
  restoreProject(projectId: string): Promise<Project>;
  deleteProject(projectId: string): Promise<Project>;

  findProjectOverview(
    projectId: string,
  ): Promise<Record<string, unknown> | null>;

  // Membership operations
  findProjectMembers(projectId: string): Promise<ProjectMember[]>;
  findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMember | null>;
  createProjectMember(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMember>;
  updateProjectMemberRole(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMember>;
  deleteProjectMember(projectId: string, userId: string): Promise<void>;
  countAdmins(projectId: string): Promise<number>;
}
