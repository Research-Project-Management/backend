/**
 * Base Domain Event.
 */
export interface IDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

export class ItemCreatedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.created';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly title: string,
    public readonly itemType: string,
    public readonly projectId?: string,
    public readonly doi?: string | null,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class ItemUpdatedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.updated';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly version: number,
    public readonly updatedFields: string[],
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class ItemDeletedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.deleted';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly version: number,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class ItemTypeChangedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.type_changed';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly previousType: string,
    public readonly newType: string,
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class ItemTagsModifiedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.tags_modified';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly action: 'add' | 'remove' | 'set',
    public readonly tagIds: string[],
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class ItemCollectionsModifiedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.collections_modified';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly action: 'assign' | 'detach',
    public readonly collectionIds: string[],
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

export class ItemMergedDomainEvent implements IDomainEvent {
  public readonly eventId: string;
  public readonly eventType = 'catalog.item.merged';
  public readonly occurredAt: Date;

  constructor(
    public readonly aggregateId: string,
    public readonly userId: string,
    public readonly mergedDuplicateIds: string[],
    public readonly aliasCitationKeys: string[],
    public readonly projectId?: string,
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}
