import { IDomainEvent } from '../events/item-domain.event';

export interface CreateCollectionProps {
  id?: string;
  userId: string;
  name: string;
  projectId?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  isExpanded?: boolean;
}

export interface ReconstituteCollectionProps {
  id: string;
  userId: string;
  name: string;
  projectId?: string | null;
  parentId?: string | null;
  sortOrder: number;
  isExpanded: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export class CollectionCreatedDomainEvent implements IDomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly eventType = 'catalog.collection.created';
  readonly occurredAt = new Date();

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly name: string,
    readonly parentId?: string | null,
    readonly projectId?: string | null,
  ) {}
}

export class CollectionUpdatedDomainEvent implements IDomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly eventType = 'catalog.collection.updated';
  readonly occurredAt = new Date();

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly version: number,
    readonly updatedFields: string[],
    readonly projectId?: string | null,
  ) {}
}

export class CollectionDeletedDomainEvent implements IDomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly eventType = 'catalog.collection.deleted';
  readonly occurredAt = new Date();

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly version: number,
    readonly projectId?: string | null,
  ) {}
}

export class CollectionAggregate {
  private readonly _id: string;
  private readonly _userId: string;
  private readonly _projectId?: string | null;
  private _name: string;
  private _parentId?: string | null;
  private _sortOrder: number;
  private _isExpanded: boolean;
  private _version: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;
  private _deletedAt?: Date | null;

  private _domainEvents: IDomainEvent[] = [];

  private constructor(props: ReconstituteCollectionProps) {
    this._id = props.id;
    this._userId = props.userId;
    this._projectId = props.projectId;
    this._name = props.name;
    this._parentId = props.parentId;
    this._sortOrder = props.sortOrder;
    this._isExpanded = props.isExpanded;
    this._version = props.version;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._deletedAt = props.deletedAt;
  }

  public static create(props: CreateCollectionProps): CollectionAggregate {
    const trimmedName = props.name?.trim();
    if (!trimmedName) {
      throw new Error('Collection name cannot be empty.');
    }
    const now = new Date();
    const id = props.id ?? crypto.randomUUID();

    const collection = new CollectionAggregate({
      id,
      userId: props.userId,
      projectId: props.projectId,
      name: trimmedName,
      parentId: props.parentId ?? null,
      sortOrder: props.sortOrder ?? 0,
      isExpanded: props.isExpanded ?? false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    collection.recordEvent(
      new CollectionCreatedDomainEvent(
        id,
        props.userId,
        trimmedName,
        props.parentId,
        props.projectId,
      ),
    );

    return collection;
  }

  public static reconstitute(
    props: ReconstituteCollectionProps,
  ): CollectionAggregate {
    return new CollectionAggregate(props);
  }

  public rename(newName: string): void {
    const trimmed = newName?.trim();
    if (!trimmed) {
      throw new Error('Collection name cannot be empty.');
    }
    if (this._name === trimmed) return;
    this._name = trimmed;
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new CollectionUpdatedDomainEvent(
        this._id,
        this._userId,
        this._version,
        ['name'],
        this._projectId,
      ),
    );
  }

  public moveToParent(newParentId: string | null): void {
    if (this._parentId === newParentId) return;
    if (newParentId === this._id) {
      throw new Error('Collection cannot be its own parent.');
    }
    this._parentId = newParentId;
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new CollectionUpdatedDomainEvent(
        this._id,
        this._userId,
        this._version,
        ['parentId'],
        this._projectId,
      ),
    );
  }

  public setSortOrder(order: number): void {
    if (this._sortOrder === order) return;
    this._sortOrder = order;
    this._version += 1;
    this._updatedAt = new Date();
  }

  public toggleExpanded(isExpanded: boolean): void {
    if (this._isExpanded === isExpanded) return;
    this._isExpanded = isExpanded;
    this._version += 1;
    this._updatedAt = new Date();
  }

  public softDelete(): void {
    if (this._deletedAt) return;
    this._deletedAt = new Date();
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new CollectionDeletedDomainEvent(
        this._id,
        this._userId,
        this._version,
        this._projectId,
      ),
    );
  }

  public restore(): void {
    if (!this._deletedAt) return;
    this._deletedAt = null;
    this._version += 1;
    this._updatedAt = new Date();
  }

  private recordEvent(event: IDomainEvent): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): IDomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }

  // Getters
  public get id(): string {
    return this._id;
  }
  public get userId(): string {
    return this._userId;
  }
  public get projectId(): string | null | undefined {
    return this._projectId;
  }
  public get name(): string {
    return this._name;
  }
  public get parentId(): string | null | undefined {
    return this._parentId;
  }
  public get sortOrder(): number {
    return this._sortOrder;
  }
  public get isExpanded(): boolean {
    return this._isExpanded;
  }
  public get version(): number {
    return this._version;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }
  public get deletedAt(): Date | null | undefined {
    return this._deletedAt;
  }
  public get isDeleted(): boolean {
    return Boolean(this._deletedAt);
  }
}
