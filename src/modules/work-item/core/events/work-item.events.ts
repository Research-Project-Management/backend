export interface WorkItemCreatedPayload {
  taskId: string;
  projectId: string;
  authorId: string;
  identifier?: string | null;
  title: string;
}

export interface WorkItemUpdatedPayload {
  taskId: string;
  projectId: string;
  actorId?: string;
  changes?: Record<string, unknown>;
}

export interface WorkItemDeletedPayload {
  taskId: string;
  projectId: string;
  actorId?: string;
}

export interface WorkItemAssignedPayload {
  taskId: string;
  projectId: string;
  assigneeId: string | null;
  actorId?: string;
}

export interface WorkItemVotedPayload {
  taskId: string;
  projectId: string;
  userId: string;
  type: 'up' | 'down';
}

export class WorkItemDomainEvent<T = any> {
  constructor(
    public readonly eventName: string,
    public readonly payload: T,
    public readonly timestamp: string = new Date().toISOString(),
  ) {}
}
