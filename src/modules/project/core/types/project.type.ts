import { Project, ProjectMember, ProjectMemberRole } from '@prisma/client';

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
};

export type EnrichedProject = ProjectWithMembers & {
  yourRole?: ProjectMemberRole | string;
  permissions?: ProjectPermissions;
};

export interface ProjectOverview {
  totalWorkItems: number;
  completedWorkItems: number;
  inProgressWorkItems: number;
  backlogWorkItems: number;
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
