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

export type ProjectWithMembers = Project & {
  createdBy?: MinimalUser | null;
  members?: ProjectMemberWithUser[];
};

export interface ProjectOverview {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  backlogTasks: number;
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
