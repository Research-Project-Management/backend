import { WorkItem, ProjectMember, Role } from '@prisma/client';

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

export interface IAssignmentRepository {
  findWorkItem(workItemId: string): Promise<WorkItem | null>;
  findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMember | null>;
  assignWorkItem(
    workItemId: string,
    assigneeId: string | null,
  ): Promise<WorkItem>;
  bulkAssignWorkItems(
    projectId: string,
    workItemIds: string[],
    assigneeId: string | null,
  ): Promise<number>;
  getProjectSettings(
    projectId: string,
  ): Promise<ProjectSettingsWithAssignee | null>;
}
