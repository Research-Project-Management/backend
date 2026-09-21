import { DoiVo } from '../value-objects/doi.vo';
import { CitationKeyVo } from '../value-objects/citation-key.vo';
import {
  ItemValidationDomainException,
  ItemConcurrencyDomainException,
} from '../exceptions/item-domain.exception';
import {
  IDomainEvent,
  ItemCreatedDomainEvent,
  ItemUpdatedDomainEvent,
  ItemDeletedDomainEvent,
  ItemTypeChangedDomainEvent,
  ItemTagsModifiedDomainEvent,
  ItemCollectionsModifiedDomainEvent,
  ItemMergedDomainEvent,
} from '../events/item-domain.event';

export interface CreateItemProps {
  id?: string;
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  fields?: Record<string, any>;
}

export interface ReconstituteItemProps {
  id: string;
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  fields?: Record<string, any>;
}

/**
 * Item Aggregate Root (Catalog Bounded Context - Core Domain).
 *
 * Encapsulates:
 * - Bibliographic metadata invariants
 * - Optimistic concurrency versioning
 * - Soft deletion state machine
 * - Domain event collection
 */
export class ItemAggregate {
  private readonly _id: string;
  private readonly _userId: string;
  private readonly _projectId?: string | null;
  private _title: string;
  private _itemType: string;
  private _doi: DoiVo | null;
  private _citationKey: CitationKeyVo | null;
  private _abstract?: string | null;
  private _year?: number | null;
  private _publicationTitle?: string | null;
  private _version: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;
  private _deletedAt?: Date | null;
  private _fields: Record<string, any>;

  private _domainEvents: IDomainEvent[] = [];

  private constructor(props: {
    id: string;
    userId: string;
    projectId?: string | null;
    title: string;
    itemType: string;
    doi: DoiVo | null;
    citationKey: CitationKeyVo | null;
    abstract?: string | null;
    year?: number | null;
    publicationTitle?: string | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    fields?: Record<string, any>;
  }) {
    this._id = props.id;
    this._userId = props.userId;
    this._projectId = props.projectId;
    this._title = props.title;
    this._itemType = props.itemType;
    this._doi = props.doi;
    this._citationKey = props.citationKey;
    this._abstract = props.abstract;
    this._year = props.year;
    this._publicationTitle = props.publicationTitle;
    this._version = props.version;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._deletedAt = props.deletedAt;
    this._fields = props.fields ?? {};
  }

  /**
   * Factory method for creating a NEW Item Aggregate.
   * Emits ItemCreatedDomainEvent.
   */
  public static create(props: CreateItemProps): ItemAggregate {
    const trimmedTitle = props.title?.trim();
    if (!trimmedTitle) {
      throw new ItemValidationDomainException('Item title cannot be empty.');
    }

    const trimmedType = props.itemType?.trim();
    if (!trimmedType) {
      throw new ItemValidationDomainException('Item type must be specified.');
    }

    const id = props.id ?? crypto.randomUUID();
    const doiVo = props.doi ? DoiVo.create(props.doi) : null;
    const citationKeyVo = props.citationKey
      ? CitationKeyVo.create(props.citationKey)
      : null;

    const now = new Date();
    const aggregate = new ItemAggregate({
      id,
      userId: props.userId,
      projectId: props.projectId,
      title: trimmedTitle,
      itemType: trimmedType,
      doi: doiVo,
      citationKey: citationKeyVo,
      abstract: props.abstract,
      year: props.year,
      publicationTitle: props.publicationTitle,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      fields: props.fields ?? {},
    });

    aggregate.recordEvent(
      new ItemCreatedDomainEvent(
        id,
        props.userId,
        trimmedTitle,
        trimmedType,
        props.projectId ?? undefined,
        doiVo?.value,
      ),
    );

    return aggregate;
  }

  /**
   * Reconstitute an aggregate from database persistence (without emitting domain events).
   */
  public static reconstitute(props: ReconstituteItemProps): ItemAggregate {
    return new ItemAggregate({
      id: props.id,
      userId: props.userId,
      projectId: props.projectId,
      title: props.title,
      itemType: props.itemType,
      doi: props.doi ? DoiVo.create(props.doi) : null,
      citationKey: props.citationKey
        ? CitationKeyVo.create(props.citationKey)
        : null,
      abstract: props.abstract,
      year: props.year,
      publicationTitle: props.publicationTitle,
      version: props.version,
      createdAt: props.createdAt,
      updatedAt: props.updatedAt,
      deletedAt: props.deletedAt,
      fields: props.fields ?? {},
    });
  }

  // ── Mutators (Business Methods) ─────────────────────────────────────────────

  public updateMetadata(
    changes: {
      title?: string;
      itemType?: string;
      doi?: string | null;
      citationKey?: string | null;
      abstract?: string | null;
      year?: number | null;
      publicationTitle?: string | null;
      fields?: Record<string, any>;
    },
    expectedVersion?: number,
  ): void {
    if (this._deletedAt) {
      throw new ItemValidationDomainException(
        `Cannot update deleted item ${this._id}. Restore it first.`,
      );
    }

    if (expectedVersion !== undefined && expectedVersion !== this._version) {
      throw new ItemConcurrencyDomainException(
        this._id,
        this._version,
        expectedVersion,
      );
    }

    const modifiedFields: string[] = [];

    if (changes.title !== undefined) {
      const trimmed = changes.title.trim();
      if (!trimmed) {
        throw new ItemValidationDomainException('Item title cannot be empty.');
      }
      this._title = trimmed;
      modifiedFields.push('title');
    }

    if (changes.itemType !== undefined) {
      const trimmed = changes.itemType.trim();
      if (!trimmed) {
        throw new ItemValidationDomainException('Item type cannot be empty.');
      }
      this._itemType = trimmed;
      modifiedFields.push('itemType');
    }

    if (changes.doi !== undefined) {
      this._doi = changes.doi ? DoiVo.create(changes.doi) : null;
      modifiedFields.push('doi');
    }

    if (changes.citationKey !== undefined) {
      this._citationKey = changes.citationKey
        ? CitationKeyVo.create(changes.citationKey)
        : null;
      modifiedFields.push('citationKey');
    }

    if (changes.abstract !== undefined) {
      this._abstract = changes.abstract;
      modifiedFields.push('abstract');
    }

    if (changes.year !== undefined) {
      this._year = changes.year;
      modifiedFields.push('year');
    }

    if (changes.publicationTitle !== undefined) {
      this._publicationTitle = changes.publicationTitle;
      modifiedFields.push('publicationTitle');
    }

    const {
      title: _t,
      itemType: _it,
      doi: _d,
      citationKey: _ck,
      abstract: _a,
      year: _y,
      publicationTitle: _pt,
      fields,
      ...extraChanges
    } = changes as any;

    if (changes.fields !== undefined || Object.keys(extraChanges).length > 0) {
      this._fields = {
        ...this._fields,
        ...(changes.fields ?? {}),
        ...extraChanges,
      };
      modifiedFields.push('fields');
    }

    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new ItemUpdatedDomainEvent(
        this._id,
        this._userId,
        this._version,
        modifiedFields,
        this._projectId ?? undefined,
      ),
    );
  }

  public softDelete(expectedVersion?: number): void {
    if (this._deletedAt) {
      return; // Idempotent
    }

    if (expectedVersion !== undefined && expectedVersion !== this._version) {
      throw new ItemConcurrencyDomainException(
        this._id,
        this._version,
        expectedVersion,
      );
    }

    this._deletedAt = new Date();
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new ItemDeletedDomainEvent(
        this._id,
        this._userId,
        this._version,
        this._projectId ?? undefined,
      ),
    );
  }

  public restore(expectedVersion?: number): void {
    if (!this._deletedAt) {
      return;
    }
    if (expectedVersion !== undefined && expectedVersion !== this._version) {
      throw new ItemConcurrencyDomainException(
        this._id,
        this._version,
        expectedVersion,
      );
    }
    this._deletedAt = null;
    this._version += 1;
    this._updatedAt = new Date();
  }

  public changeType(newType: string): void {
    if (this._deletedAt) {
      throw new ItemValidationDomainException(
        `Cannot change type of deleted item ${this._id}. Restore it first.`,
      );
    }
    const trimmed = newType?.trim();
    if (!trimmed) {
      throw new ItemValidationDomainException('Item type cannot be empty.');
    }
    if (this._itemType === trimmed) {
      return; // Idempotent
    }
    const previousType = this._itemType;
    this._itemType = trimmed;
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new ItemTypeChangedDomainEvent(
        this._id,
        this._userId,
        previousType,
        trimmed,
        this._projectId ?? undefined,
      ),
    );
  }

  public recordTagsModified(
    action: 'add' | 'remove' | 'set',
    tagIds: string[],
  ): void {
    if (this._deletedAt) {
      throw new ItemValidationDomainException(
        `Cannot modify tags on deleted item ${this._id}. Restore it first.`,
      );
    }
    if (!tagIds || tagIds.length === 0) return;
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new ItemTagsModifiedDomainEvent(
        this._id,
        this._userId,
        action,
        tagIds,
        this._projectId ?? undefined,
      ),
    );
  }

  public recordCollectionsModified(
    action: 'assign' | 'detach',
    collectionIds: string[],
  ): void {
    if (this._deletedAt) {
      throw new ItemValidationDomainException(
        `Cannot modify collections on deleted item ${this._id}. Restore it first.`,
      );
    }
    if (!collectionIds || collectionIds.length === 0) return;
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new ItemCollectionsModifiedDomainEvent(
        this._id,
        this._userId,
        action,
        collectionIds,
        this._projectId ?? undefined,
      ),
    );
  }

  public recordMergedDuplicate(
    duplicateItemIds: string[],
    aliasCitationKeys: string[] = [],
  ): void {
    if (this._deletedAt) {
      throw new ItemValidationDomainException(
        `Cannot merge duplicates into deleted item ${this._id}. Restore it first.`,
      );
    }
    if (!duplicateItemIds || duplicateItemIds.length === 0) return;
    this._version += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new ItemMergedDomainEvent(
        this._id,
        this._userId,
        duplicateItemIds,
        aliasCitationKeys,
        this._projectId ?? undefined,
      ),
    );
  }

  public isOwnedBy(userId: string): boolean {
    return this._userId === userId;
  }

  public belongsToProject(projectId?: string | null): boolean {
    if (!projectId && !this._projectId) return true;
    return this._projectId === projectId;
  }

  // ── Event Lifecycle ────────────────────────────────────────────────────────

  private recordEvent(event: IDomainEvent): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): IDomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  public get id(): string {
    return this._id;
  }
  public get userId(): string {
    return this._userId;
  }
  public get projectId(): string | null | undefined {
    return this._projectId;
  }
  public get title(): string {
    return this._title;
  }
  public get itemType(): string {
    return this._itemType;
  }
  public get doi(): string | null {
    return this._doi?.value ?? null;
  }
  public get citationKey(): string | null {
    return this._citationKey?.value ?? null;
  }
  public get abstract(): string | null | undefined {
    return this._abstract;
  }
  public get year(): number | null | undefined {
    return this._year;
  }
  public get publicationTitle(): string | null | undefined {
    return this._publicationTitle;
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
  public get fields(): Record<string, any> {
    return { ...this._fields };
  }
  public get isDeleted(): boolean {
    return this._deletedAt !== null && this._deletedAt !== undefined;
  }
  public get authors(): string[] {
    return Array.isArray(this._fields.authors) ? this._fields.authors : [];
  }
  public get creators(): any[] {
    return Array.isArray(this._fields.creators) ? this._fields.creators : [];
  }
  public get contributors(): any[] {
    return Array.isArray(this._fields.contributors)
      ? this._fields.contributors
      : [];
  }
  public get tags(): string[] {
    return Array.isArray(this._fields.tags) ? this._fields.tags : [];
  }
  public get attachments(): any[] {
    return Array.isArray(this._fields.attachments)
      ? this._fields.attachments
      : [];
  }
  public get primaryFile(): any {
    return this._fields.primaryFile ?? null;
  }
  public get fileUrl(): string {
    return this._fields.fileUrl ?? '';
  }
  public get collections(): any[] {
    return Array.isArray(this._fields.collections)
      ? this._fields.collections
      : [];
  }
  public get collectionIds(): string[] {
    return Array.isArray(this._fields.collectionIds)
      ? this._fields.collectionIds
      : [];
  }
  public get collectionId(): string | null {
    return this._fields.collectionId ?? null;
  }
  public get notes(): any[] {
    return Array.isArray(this._fields.notes) ? this._fields.notes : [];
  }
  public get readStatus(): string {
    return this._fields.readStatus ?? 'unread';
  }
  public get rating(): number {
    return typeof this._fields.rating === 'number' ? this._fields.rating : 0;
  }
  public get lastReadAt(): string | null {
    return this._fields.lastReadAt ?? null;
  }
  public get identifiers(): any[] {
    return Array.isArray(this._fields.identifiers)
      ? this._fields.identifiers
      : [];
  }
}
