import { Task, ProjectMember, ProjectMemberRole } from '@prisma/client';

export interface AssignTaskResult {
  task: Task;
  previousAssigneeId: string | null;
  newAssigneeId: string | null;
}

export interface BulkAssignResult {
  updatedCount: number;
  taskIds: string[];
  assigneeId: string | null;
}

export interface ProjectSettingsWithAssignee {
  defaultAssigneeId?: string | null;
  [key: string]: unknown;
}

export const ELIGIBLE_ASSIGNEE_ROLES: readonly ProjectMemberRole[] = [
  ProjectMemberRole.admin,
  ProjectMemberRole.contributor,
] as const;

export interface IAssignmentRepository {
  findTask(taskId: string): Promise<Task | null>;
  findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMember | null>;
  assignTask(taskId: string, assigneeId: string | null): Promise<Task>;
  bulkAssignTasks(
    projectId: string,
    taskIds: string[],
    assigneeId: string | null,
  ): Promise<number>;
  getProjectSettings(
    projectId: string,
  ): Promise<ProjectSettingsWithAssignee | null>;
}
