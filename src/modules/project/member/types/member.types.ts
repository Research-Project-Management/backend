import { ProjectMember, ProjectMemberRole } from '@prisma/client';

export type MinimalUser = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
};

export type ProjectMemberWithUser = ProjectMember & {
  user: MinimalUser;
};

export interface ProjectMemberListResponse {
  members: ProjectMemberWithUser[];
  total: number;
  page?: number;
  limit?: number;
}

export interface BulkAddProjectMembersResult {
  addedCount: number;
  skippedCount: number;
  members: ProjectMemberWithUser[];
}

export interface IMemberRepository {
  findMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMemberWithUser | null>;
  findMembers(
    projectId: string,
    options?: {
      role?: ProjectMemberRole;
      search?: string;
      take?: number;
      skip?: number;
    },
  ): Promise<ProjectMemberWithUser[]>;
  countMembers(
    projectId: string,
    options?: {
      role?: ProjectMemberRole;
      search?: string;
    },
  ): Promise<number>;
  createMember(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMemberWithUser>;
  updateMemberRole(
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ProjectMemberWithUser>;
  deleteMember(projectId: string, userId: string): Promise<void>;
  countAdmins(projectId: string): Promise<number>;
  findWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null>;
  findProject(projectId: string): Promise<{
    id: string;
    workspaceId: string;
    leadId: string | null;
  } | null>;
  unassignMemberTasks(projectId: string, userId: string): Promise<number>;
  clearProjectLeadIfMatches(projectId: string, userId: string): Promise<void>;
}
