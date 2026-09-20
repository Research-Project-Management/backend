import { ProjectMember, Role } from '@prisma/client';

export { Role };

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

export interface FindMembersOptions {
  role?: Role;
  search?: string;
  take?: number;
  skip?: number;
}
