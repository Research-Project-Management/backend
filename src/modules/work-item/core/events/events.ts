export interface WorkItemCreatedPayload {
  workItemId: string;
  projectId: string;
  authorId: string;
  identifier?: string | null;
  sequenceNumber?: number | null;
  title: string;
  columnId?: string;
}

export interface WorkItemUpdatedPayload {
  workItemId: string;
  projectId: string;
  actorId?: string;
  changes?: Record<string, unknown>;
}

export interface WorkItemStateChangedPayload {
  workItemId: string;
  projectId: string;
  oldColumnId: string;
  newColumnId: string;
  actorId?: string;
}

export interface WorkItemDeletedPayload {
  workItemId: string;
  projectId: string;
  actorId?: string;
}

export interface WorkItemAssignedPayload {
  workItemId: string;
  projectId: string;
  assigneeId: string | null;
  actorId?: string;
}

export interface WorkItemVotedPayload {
  workItemId: string;
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
