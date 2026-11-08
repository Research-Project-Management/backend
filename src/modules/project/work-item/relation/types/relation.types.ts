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
  | 'start_to_finish'
  | 'finish_to_start'
  | 'start_to_start'
  | 'finish_to_finish'
  | 'FINISH_TO_START'
  | 'START_TO_START'
  | 'FINISH_TO_FINISH'
  | 'START_TO_FINISH'
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
  start_to_finish: 'Start to finish',
  finish_to_start: 'Finish to start',
  start_to_start: 'Start to start',
  finish_to_finish: 'Finish to finish',
  FINISH_TO_START: 'Finish to start',
  START_TO_START: 'Start to start',
  FINISH_TO_FINISH: 'Finish to finish',
  START_TO_FINISH: 'Start to finish',
  implements: 'Implements',
};

/** Whether the relation type is a scheduling/timeline dependency */
export const TIMELINE_RELATION_TYPES: RelationType[] = [
  'blocks',
  'blocked_by',
  'starts_before',
  'starts_after',
  'finishes_before',
  'finishes_after',
  'start_to_finish',
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
  'FINISH_TO_START',
  'START_TO_START',
  'FINISH_TO_FINISH',
  'START_TO_FINISH',
];

export interface WorkItemRelationItem {
  id?: string;
  targetWorkItemId: string;
  type: RelationType;
  createdAt: string;
}

export interface EnrichedRelationItem extends WorkItemRelationItem {
  targetWorkItem?: {
    id: string;
    title: string;
    identifier?: string | null;
    columnId?: string;
    priority?: string;
    completed?: boolean;
  } | null;
}
