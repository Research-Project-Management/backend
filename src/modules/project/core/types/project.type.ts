import { Project, ProjectMember, ProjectMemberRole, ProjectLabel } from '@prisma/client';

import {
  MinimalUser,
  ProjectMemberWithUser,
  ProjectMemberListResponse,
  BulkAddProjectMembersResult,
} from '../../member/types/member.type';

export {
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
  createdBy?: MinimalUser | null;
  members?: ProjectMemberWithUser[];
  labels?: Array<{ label: ProjectLabel }>;
};

export type EnrichedProject = ProjectWithMembers & {
  yourRole?: ProjectMemberRole;
  permissions?: ProjectPermissions;
  isFavorite?: boolean;
  projectLabelsList?: ProjectLabel[];
};

export interface ProjectOverview {
  totalWorkItems: number;
  completedWorkItems: number;
  inProgressWorkItems: number;
  backlogWorkItems: number;
  completionPercentage: number;
  daysRemaining?: number | null;
  isOverdue?: boolean;
  totalMembers: number;
  totalCycles: number;
  activeCycle?: {
    id: string;
    name: string;
    progressPercentage: number;
  } | null;
}

export interface AllocatedIdentifier {
  identifier: string;
  sequenceNumber: number;
}
