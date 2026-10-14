import { WorkItem, Role } from '@prisma/client';

export { Role };

export interface AssignWorkItemResult {
  workItem: WorkItem;
  previousAssigneeId: string | null;
  newAssigneeId: string | null;
}

export interface BulkAssignResult {
  updatedCount: number;
  workItemIds: string[];
  assigneeId: string | null;
}

export interface ProjectSettingsWithAssignee {
  defaultAssigneeId?: string | null;
  [key: string]: unknown;
}

export const ELIGIBLE_ASSIGNEE_ROLES: readonly Role[] = [
  Role.owner,
  Role.coordinator,
  Role.contributor,
] as const;
