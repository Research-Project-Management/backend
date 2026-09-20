/**
 * Annotation Entity — Content Domain Layer
 *
 * Represents a user annotation on a PDF page or text range within an attachment.
 * Pure domain object — zero NestJS or Prisma imports.
 */

export type AnnotationType =
  | 'highlight'
  | 'note'
  | 'underline'
  | 'strikethrough'
  | 'freetext'
  | 'image'
  | 'ink';

export interface AnnotationPosition {
  pageIndex: number;
  rects?: Array<[number, number, number, number]>;
  paths?: Array<Array<[number, number]>>;
}

export interface CreateAnnotationProps {
  id?: string;
  attachmentId: string;
  itemId: string;
  userId: string;
  type: AnnotationType;
  color?: string;
  text?: string;
  comment?: string;
  position?: AnnotationPosition;
  pageIndex?: number;
  sortIndex?: string;
  isAuthoritative?: boolean;
}

export interface ReconstituteAnnotationProps {
  id: string;
  attachmentId: string;
  itemId: string;
  userId: string;
  type: AnnotationType;
  color: string;
  text?: string | null;
  comment?: string | null;
  position?: AnnotationPosition | null;
  pageIndex?: number | null;
  sortIndex?: string | null;
  isAuthoritative: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class AnnotationEntity {
  private readonly _id: string;
  private readonly _attachmentId: string;
  private readonly _itemId: string;
  private readonly _userId: string;
  private readonly _type: AnnotationType;
  private _color: string;
  private _text?: string | null;
  private _comment?: string | null;
  private _position?: AnnotationPosition | null;
  private _pageIndex?: number | null;
  private _sortIndex?: string | null;
  private readonly _isAuthoritative: boolean;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: ReconstituteAnnotationProps) {
    this._id = props.id;
    this._attachmentId = props.attachmentId;
    this._itemId = props.itemId;
    this._userId = props.userId;
    this._type = props.type;
    this._color = props.color;
    this._text = props.text;
    this._comment = props.comment;
    this._position = props.position;
    this._pageIndex = props.pageIndex;
    this._sortIndex = props.sortIndex;
    this._isAuthoritative = props.isAuthoritative;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreateAnnotationProps): AnnotationEntity {
    const now = new Date();
    return new AnnotationEntity({
      id: props.id ?? crypto.randomUUID(),
      attachmentId: props.attachmentId,
      itemId: props.itemId,
      userId: props.userId,
      type: props.type,
      color: props.color ?? '#ffd700',
      text: props.text,
      comment: props.comment,
      position: props.position,
      pageIndex: props.pageIndex,
      sortIndex: props.sortIndex,
      isAuthoritative: props.isAuthoritative ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  static reconstitute(props: ReconstituteAnnotationProps): AnnotationEntity {
    return new AnnotationEntity(props);
  }

  // Getters
  get id(): string {
    return this._id;
  }
  get attachmentId(): string {
    return this._attachmentId;
  }
  get itemId(): string {
    return this._itemId;
  }
  get userId(): string {
    return this._userId;
  }
  get type(): AnnotationType {
    return this._type;
  }
  get color(): string {
    return this._color;
  }
  get text(): string | null | undefined {
    return this._text;
  }
  get comment(): string | null | undefined {
    return this._comment;
  }
  get position(): AnnotationPosition | null | undefined {
    return this._position;
  }
  get pageIndex(): number | null | undefined {
    return this._pageIndex;
  }
  get sortIndex(): string | null | undefined {
    return this._sortIndex;
  }
  get isAuthoritative(): boolean {
    return this._isAuthoritative;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  updateComment(comment: string): void {
    this._comment = comment;
    this._updatedAt = new Date();
  }

  updateColor(color: string): void {
    this._color = color;
    this._updatedAt = new Date();
  }
}
