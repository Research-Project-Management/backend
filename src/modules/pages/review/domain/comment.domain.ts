import * as crypto from 'node:crypto';
import { InvalidReplyError, InvalidThreadError } from './review.errors';
import { TextRange } from './text-range.domain';

export interface CommentReplyProps {
  id?: string;
  threadId: string;
  content: string;
  createdById?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class CommentReply {
  private readonly _id: string;
  private readonly _threadId: string;
  private _content: string;
  private readonly _createdById: string | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: CommentReplyProps) {
    if (!props.content || !props.content.trim()) {
      throw new InvalidReplyError('Reply content cannot be empty.');
    }
    this._id = props.id ?? crypto.randomUUID();
    this._threadId = props.threadId;
    this._content = props.content.trim();
    this._createdById = props.createdById ?? null;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CommentReplyProps): CommentReply {
    return new CommentReply(props);
  }

  public get id(): string {
    return this._id;
  }
  public get threadId(): string {
    return this._threadId;
  }
  public get content(): string {
    return this._content;
  }
  public get createdById(): string | null {
    return this._createdById;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      threadId: this._threadId,
      content: this._content,
      createdById: this._createdById,
      createdAt: this._createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}

export interface CommentThreadProps {
  id?: string;
  spaceId?: string;
  projectId?: string;
  pageId?: string | null;
  docId: string;
  quote?: string | null;
  range: TextRange;
  anchorStart?: Uint8Array | null;
  anchorEnd?: Uint8Array | null;
  baseDocRev?: number | null;
  isResolved?: boolean;
  createdById?: string | null;
  resolvedById?: string | null;
  resolvedAt?: Date | null;
  replies?: CommentReply[];
  createdAt?: Date;
  updatedAt?: Date;
}

export class CommentThread {
  private readonly _id: string;
  private readonly _spaceId: string;
  private readonly _pageId: string | null;
  private readonly _docId: string;
  private readonly _quote: string | null;
  private readonly _range: TextRange;
  private readonly _anchorStart: Uint8Array | null;
  private readonly _anchorEnd: Uint8Array | null;
  private readonly _baseDocRev: number | null;
  private _isResolved: boolean;
  private readonly _createdById: string | null;
  private _resolvedById: string | null;
  private _resolvedAt: Date | null;
  private readonly _replies: CommentReply[];
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: CommentThreadProps) {
    const spaceId = props.spaceId ?? props.projectId;
    if (!spaceId || !spaceId.trim()) {
      throw new InvalidThreadError('Space ID cannot be empty.');
    }
    if (!props.docId || !props.docId.trim()) {
      throw new InvalidThreadError('Document ID cannot be empty.');
    }

    this._id = props.id ?? crypto.randomUUID();
    this._spaceId = spaceId;
    this._pageId = props.pageId ?? null;
    this._docId = props.docId;
    this._quote = props.quote ?? null;
    this._range = props.range;
    this._anchorStart = props.anchorStart ?? null;
    this._anchorEnd = props.anchorEnd ?? null;
    this._baseDocRev = props.baseDocRev ?? null;
    this._isResolved = props.isResolved ?? false;
    this._createdById = props.createdById ?? null;
    this._resolvedById = props.resolvedById ?? null;
    this._resolvedAt = props.resolvedAt ?? null;
    this._replies = props.replies ? [...props.replies] : [];
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CommentThreadProps): CommentThread {
    return new CommentThread(props);
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
  public get quote(): string | null {
    return this._quote;
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
  public get isResolved(): boolean {
    return this._isResolved;
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
  public get replies(): CommentReply[] {
    return [...this._replies];
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public addReply(reply: CommentReply): void {
    if (this._isResolved) {
      throw new InvalidThreadError(
        'Cannot add reply to a resolved comment thread.',
      );
    }
    this._replies.push(reply);
    this._updatedAt = new Date();
  }

  public resolve(resolvedBy?: string | null): void {
    if (this._isResolved) {
      throw new InvalidThreadError('Comment thread is already resolved.');
    }
    this._isResolved = true;
    this._resolvedById = resolvedBy ?? null;
    this._resolvedAt = new Date();
    this._updatedAt = new Date();
  }

  public toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      spaceId: this._spaceId,
      docId: this._docId,
      quote: this._quote,
      range: this._range.toJSON(),
      isResolved: this._isResolved,
      createdById: this._createdById,
      resolvedById: this._resolvedById,
      resolvedAt: this._resolvedAt?.toISOString() ?? null,
      replies: this._replies.map((r) => r.toJSON()),
      createdAt: this._createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}
