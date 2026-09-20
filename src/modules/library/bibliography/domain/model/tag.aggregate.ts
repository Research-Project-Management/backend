import { IDomainEvent } from '../events/item-domain.event';

export interface CreateTagProps {
  id?: string;
  userId: string;
  name: string;
  projectId?: string | null;
  color?: string | null;
  type?: 'manual' | 'automatic';
}

export interface ReconstituteTagProps {
  id: string;
  userId: string;
  name: string;
  projectId?: string | null;
  color?: string | null;
  type: 'manual' | 'automatic';
  createdAt: Date;
  updatedAt: Date;
}

export class TagCreatedDomainEvent implements IDomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly eventType = 'catalog.tag.created';
  readonly occurredAt = new Date();

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly name: string,
    readonly type: string,
    readonly projectId?: string | null,
  ) {}
}

export class TagDeletedDomainEvent implements IDomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly eventType = 'catalog.tag.deleted';
  readonly occurredAt = new Date();

  constructor(
    readonly aggregateId: string,
    readonly userId: string,
    readonly name: string,
    readonly projectId?: string | null,
  ) {}
}

export class TagAggregate {
  private readonly _id: string;
  private readonly _userId: string;
  private readonly _projectId?: string | null;
  private _name: string;
  private _color?: string | null;
  private _type: 'manual' | 'automatic';
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private _domainEvents: IDomainEvent[] = [];

  private constructor(props: ReconstituteTagProps) {
    this._id = props.id;
    this._userId = props.userId;
    this._projectId = props.projectId;
    this._name = props.name;
    this._color = props.color;
    this._type = props.type;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  public static create(props: CreateTagProps): TagAggregate {
    const trimmed = props.name?.trim();
    if (!trimmed) {
      throw new Error('Tag name cannot be empty.');
    }
    const now = new Date();
    const id = props.id ?? crypto.randomUUID();
    const tag = new TagAggregate({
      id,
      userId: props.userId,
      projectId: props.projectId,
      name: trimmed,
      color: props.color ?? null,
      type: props.type ?? 'manual',
      createdAt: now,
      updatedAt: now,
    });

    tag.recordEvent(
      new TagCreatedDomainEvent(
        id,
        props.userId,
        trimmed,
        tag._type,
        props.projectId,
      ),
    );

    return tag;
  }

  public static reconstitute(props: ReconstituteTagProps): TagAggregate {
    return new TagAggregate(props);
  }

  public rename(newName: string): void {
    const trimmed = newName?.trim();
    if (!trimmed) {
      throw new Error('Tag name cannot be empty.');
    }
    this._name = trimmed;
    this._updatedAt = new Date();
  }

  public changeColor(color: string | null): void {
    this._color = color;
    this._updatedAt = new Date();
  }

  public convertToManual(): void {
    if (this._type === 'manual') return;
    this._type = 'manual';
    this._updatedAt = new Date();
  }

  public markDeleted(): void {
    this.recordEvent(
      new TagDeletedDomainEvent(
        this._id,
        this._userId,
        this._name,
        this._projectId,
      ),
    );
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
  public get color(): string | null | undefined {
    return this._color;
  }
  public get type(): 'manual' | 'automatic' {
    return this._type;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }
}
