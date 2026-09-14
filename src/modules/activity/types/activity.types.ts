import { EntityType } from '@prisma/client';

export type WorkItemVerb =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'assigned'
  | 'unassigned'
  | 'deleted'
  | 'transitioned'
  | 'archived'
  | 'restored';

export type PaperVerb =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'imported'
  | 'analyzed';

export type PageVerb =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'published';

export interface BaseActivityEvent {
  entityId: string;
  actorId: string;
  projectId?: string | null;
  timestamp?: Date;
}

export interface WorkItemActivityEvent extends BaseActivityEvent {
  entityType: 'work_item' | 'item';
  verb: WorkItemVerb;
  field?: 'columnId' | 'priority' | 'assigneeId' | 'title' | 'description' | 'state' | string;
  oldValue?: string;
  newValue?: string;
  oldIdentifier?: string;
  newIdentifier?: string;
}

export interface PaperActivityEvent extends BaseActivityEvent {
  entityType: 'paper';
  verb: PaperVerb;
  field?: 'title' | 'ragStatus' | 'collectionId';
  oldValue?: string;
  newValue?: string;
}

export interface PageActivityEvent extends BaseActivityEvent {
  entityType: 'page';
  verb: PageVerb;
  field?: 'title' | 'content';
  oldValue?: string;
  newValue?: string;
}

export interface GenericActivityEvent extends BaseActivityEvent {
  entityType: EntityType;
  verb: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  oldIdentifier?: string;
  newIdentifier?: string;
}

export type DomainActivityEvent =
  | WorkItemActivityEvent
  | PaperActivityEvent
  | PageActivityEvent
  | GenericActivityEvent;
