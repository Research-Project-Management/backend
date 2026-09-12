import { Task, Prisma } from '@prisma/client';

export type RelationType =
  | 'blocks'
  | 'blocked_by'
  | 'relates_to'
  | 'duplicate_of'
  | 'duplicated_by'
  | 'starts_before'
  | 'starts_after'
  | 'finishes_before'
  | 'finishes_after'
  | 'implements';

/** Human-readable label for each relation type */
export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocked by',
  relates_to: 'Relates to',
  duplicate_of: 'Duplicate of',
  duplicated_by: 'Duplicated by',
  starts_before: 'Starts before',
  starts_after: 'Starts after',
  finishes_before: 'Finishes before',
  finishes_after: 'Finishes after',
  implements: 'Implements',
};

/** Whether the relation type is a scheduling/timeline dependency */
export const TIMELINE_RELATION_TYPES: RelationType[] = [
  'blocks', 'blocked_by',
  'starts_before', 'starts_after',
  'finishes_before', 'finishes_after',
];

export interface WorkItemRelationItem {
  id?: string;
  targetTaskId: string;
  type: RelationType;
  createdAt: string;
}

export interface EnrichedRelationItem extends WorkItemRelationItem {
  targetTask?: {
    id: string;
    title: string;
    identifier?: string | null;
    columnId?: string;
    priority?: string;
    completed?: boolean;
  } | null;
}

export interface IRelationRepository {
  findTask(taskId: string): Promise<Task | null>;
  findTasksByIds(taskIds: string[]): Promise<Task[]>;
  updateTaskRelations(
    taskId: string,
    relations: Prisma.InputJsonValue,
  ): Promise<Task>;
  executeTransaction(operations: any[]): Promise<any>;
}
