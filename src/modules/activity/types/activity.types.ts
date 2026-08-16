import { EntityType } from '@prisma/client';

export type TaskVerb =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'assigned'
  | 'unassigned'
  | 'deleted';

export type PaperVerb =
  | 'uploaded'
  | 'metadata_extracted'
  | 'updated'
  | 'deleted';

export type PageVerb =
  | 'created'
  | 'saved'
  | 'version_created'
  | 'deleted';

export type GenericVerb =
  | 'created'
  | 'updated'
  | 'deleted';

export interface BaseActivityEvent {
  entityId: string;
  actorId: string;
  workspaceId: string;
  projectId?: string | null;
  timestamp?: Date;
}

export interface TaskActivityEvent extends BaseActivityEvent {
  entityType: 'task';
  verb: TaskVerb;
  field?: 'columnId' | 'priority' | 'assigneeId' | 'title' | 'description';
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
  | TaskActivityEvent
  | PaperActivityEvent
  | PageActivityEvent
  | GenericActivityEvent;
