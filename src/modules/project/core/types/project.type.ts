import {
  Project,
  ProjectMember,
  Role,
  ProjectLabel,
  ProjectState,
} from '@prisma/client';

import type {
  MinimalUser,
  ProjectMemberWithUser,
  ProjectMemberListResponse,
  BulkAddProjectMembersResult,
} from '../../member/types/member.type';

export type {
  MinimalUser,
  ProjectMemberWithUser,
  ProjectMemberListResponse,
  BulkAddProjectMembersResult,
};

export interface ProjectPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canManageMembers: boolean;
  canLeave: boolean;
}

export type ProjectWithMembers = Project & {
  state?: ProjectState | null;
  createdBy?: MinimalUser | null;
  members?: ProjectMemberWithUser[];
  labels?: Array<{ label: ProjectLabel }>;
};

export type EnrichedProject = ProjectWithMembers & {
  yourRole?: Role;
  permissions?: ProjectPermissions;
  isFavorite?: boolean;
  projectLabelsList?: ProjectLabel[];
};

export interface AllocatedIdentifier {
  identifier: string;
  sequenceNumber: number;
}
