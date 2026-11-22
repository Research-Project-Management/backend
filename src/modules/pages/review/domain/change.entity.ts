import * as crypto from 'node:crypto';
import { InvalidChangeError } from './errors';
import { TextRange } from './text-range';

export type ChangeType = 'insert' | 'delete';
export type ChangeStatus = 'pending' | 'accepted' | 'rejected';

export interface TrackChangeProps {
  id?: string;
  spaceId?: string;
  projectId?: string;
  pageId?: string | null;
  docId: string;
  groupId?: string | null;
  type: ChangeType;
  status?: ChangeStatus;
  text: string;
  range: TextRange;
  anchorStart?: Uint8Array | null;
  anchorEnd?: Uint8Array | null;
  baseDocRev?: number | null;
  createdById?: string | null;
  resolvedById?: string | null;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class TrackChange {
  private readonly _id: string;
  private readonly _spaceId: string;
  private readonly _pageId: string | null;
  private readonly _docId: string;
  private readonly _groupId: string | null;
  private readonly _type: ChangeType;
  private _status: ChangeStatus;
  private readonly _text: string;
  private readonly _range: TextRange;
  private readonly _anchorStart: Uint8Array | null;
  private readonly _anchorEnd: Uint8Array | null;
  private readonly _baseDocRev: number | null;
  private readonly _createdById: string | null;
  private _resolvedById: string | null;
  private _resolvedAt: Date | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  public constructor(props: TrackChangeProps) {
    const spaceId = props.spaceId ?? props.projectId;
    if (!spaceId || !spaceId.trim()) {
      throw new InvalidChangeError('Space ID cannot be empty.');
    }
    if (!props.docId || !props.docId.trim()) {
      throw new InvalidChangeError('Document ID cannot be empty.');
    }

    this._id = props.id ?? crypto.randomUUID();
    this._spaceId = spaceId;
    this._pageId = props.pageId ?? null;
    this._docId = props.docId;
    this._groupId = props.groupId ?? null;
    this._type = props.type;
    this._status = props.status ?? 'pending';
    this._text = props.text;
    this._range = props.range;
    this._anchorStart = props.anchorStart ?? null;
    this._anchorEnd = props.anchorEnd ?? null;
    this._baseDocRev = props.baseDocRev ?? null;
    this._createdById = props.createdById ?? null;
    this._resolvedById = props.resolvedById ?? null;
    this._resolvedAt = props.resolvedAt ?? null;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: TrackChangeProps): TrackChange {
    return new TrackChange(props);
  }

  public get id(): string {
    return this._id;
  }
  public get spaceId(): string {
    return this._spaceId;
  }
  public get pageId(): string | null {
    return this._pageId;
  }
  public get docId(): string {
    return this._docId;
  }
  public get groupId(): string | null {
    return this._groupId;
  }
  public get type(): ChangeType {
    return this._type;
  }
  public get status(): ChangeStatus {
    return this._status;
  }
  public get text(): string {
    return this._text;
  }
  public get range(): TextRange {
    return this._range;
  }
  public get anchorStart(): Uint8Array | null {
    return this._anchorStart;
  }
  public get anchorEnd(): Uint8Array | null {
    return this._anchorEnd;
  }
  public get baseDocRev(): number | null {
    return this._baseDocRev;
  }
  public get createdById(): string | null {
    return this._createdById;
  }
  public get resolvedById(): string | null {
    return this._resolvedById;
  }
  public get resolvedAt(): Date | null {
    return this._resolvedAt;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public isPending(): boolean {
    return this._status === 'pending';
  }

  public accept(resolvedBy?: string | null): void {
    if (!this.isPending()) {
      throw new InvalidChangeError(
        `Change '${this._id}' has already been ${this._status}.`,
      );
    }
    this._status = 'accepted';
    this._resolvedById = resolvedBy ?? null;
    this._resolvedAt = new Date();
    this._updatedAt = new Date();
  }

  public reject(resolvedBy?: string | null): void {
    if (!this.isPending()) {
      throw new InvalidChangeError(
        `Change '${this._id}' has already been ${this._status}.`,
      );
    }
    this._status = 'rejected';
    this._resolvedById = resolvedBy ?? null;
    this._resolvedAt = new Date();
    this._updatedAt = new Date();
  }

  public reopen(): void {
    this._status = 'pending';
    this._resolvedById = null;
    this._resolvedAt = null;
    this._updatedAt = new Date();
  }

  public toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      spaceId: this._spaceId,
      docId: this._docId,
      type: this._type,
      status: this._status,
      text: this._text,
      range: this._range.toJSON(),
      createdById: this._createdById,
      resolvedById: this._resolvedById,
      resolvedAt: this._resolvedAt?.toISOString() ?? null,
      createdAt: this._createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}
