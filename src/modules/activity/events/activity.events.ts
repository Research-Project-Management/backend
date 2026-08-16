import { EntityType } from '@prisma/client';
import { DomainActivityEvent as TypedDomainActivityEvent } from '../types/activity.types';

export class DomainActivityEvent {
  entityType!: EntityType;
  entityId!: string;
  verb!: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  oldIdentifier?: string;
  newIdentifier?: string;
  actorId!: string;
  workspaceId!: string;
  projectId?: string;
  timestamp?: Date;

  constructor(partial: Partial<TypedDomainActivityEvent>) {
    Object.assign(this, partial);
    this.timestamp = this.timestamp || new Date();
  }
}

export * from '../types/activity.types';
