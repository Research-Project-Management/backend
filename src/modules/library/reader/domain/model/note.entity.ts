/**
 * Note Entity — Content Domain Layer
 *
 * Represents a rich-text note associated with a library item.
 * Pure domain object — zero NestJS or Prisma imports.
 */

export interface CreateNoteProps {
  id?: string;
  itemId: string;
  userId: string;
  title?: string;
  content?: string;
  contentHtml?: string;
  parentId?: string | null;
}

export interface ReconstituteNoteProps {
  id: string;
  itemId: string;
  userId: string;
  title?: string | null;
  content?: string | null;
  contentHtml?: string | null;
  parentId?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export class NoteEntity {
  private readonly _id: string;
  private readonly _itemId: string;
  private readonly _userId: string;
  private _title?: string | null;
  private _content?: string | null;
  private _contentHtml?: string | null;
  private _parentId?: string | null;
  private _version: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;
  private _deletedAt?: Date | null;

  private constructor(props: ReconstituteNoteProps) {
    this._id = props.id;
    this._itemId = props.itemId;
    this._userId = props.userId;
    this._title = props.title;
    this._content = props.content;
    this._contentHtml = props.contentHtml;
    this._parentId = props.parentId;
    this._version = props.version;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._deletedAt = props.deletedAt;
  }

  static create(props: CreateNoteProps): NoteEntity {
    const now = new Date();
    return new NoteEntity({
      id: props.id ?? crypto.randomUUID(),
      itemId: props.itemId,
      userId: props.userId,
      title: props.title,
      content: props.content,
      contentHtml: props.contentHtml,
      parentId: props.parentId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  static reconstitute(props: ReconstituteNoteProps): NoteEntity {
    return new NoteEntity(props);
  }

  // Getters
  get id(): string {
    return this._id;
  }
  get itemId(): string {
    return this._itemId;
  }
  get userId(): string {
    return this._userId;
  }
  get title(): string | null | undefined {
    return this._title;
  }
  get content(): string | null | undefined {
    return this._content;
  }
  get contentHtml(): string | null | undefined {
    return this._contentHtml;
  }
  get parentId(): string | null | undefined {
    return this._parentId;
  }
  get version(): number {
    return this._version;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get deletedAt(): Date | null | undefined {
    return this._deletedAt;
  }
  get isDeleted(): boolean {
    return this._deletedAt != null;
  }

  updateContent(content?: string, contentHtml?: string, title?: string): void {
    if (content !== undefined) this._content = content;
    if (contentHtml !== undefined) this._contentHtml = contentHtml;
    if (title !== undefined) this._title = title;
    this._version += 1;
    this._updatedAt = new Date();
  }

  reassignToItem(targetItemId: string): void {
    if (!targetItemId) throw new Error('Target item ID cannot be empty');
    (this as any)._itemId = targetItemId;
    this._version += 1;
    this._updatedAt = new Date();
  }

  softDelete(): void {
    this._deletedAt = new Date();
    this._version += 1;
    this._updatedAt = new Date();
  }

  restore(): void {
    this._deletedAt = null;
    this._version += 1;
    this._updatedAt = new Date();
  }
}

export { NoteEntity as NoteAggregate };
