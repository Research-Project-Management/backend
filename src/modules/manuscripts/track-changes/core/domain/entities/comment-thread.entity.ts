/**
 * track-changes/core/domain/entities/comment-thread.entity.ts
 * Domain Aggregate Entity representing an inline margin comment thread pinned to text coordinates.
 */

import * as crypto from 'node:crypto';
import { TextRangeVo } from '../value-objects/text-range.vo';
import { CommentReply } from './comment-reply.entity';

export interface CreateCommentThreadProps {
  id?: string;
  projectId: string;
  docId: string;
  quote?: string | null;
  range: TextRangeVo;
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
  private readonly _projectId: string;
  private readonly _docId: string;
  private readonly _quote: string | null;
  private readonly _range: TextRangeVo;
  private _isResolved: boolean;
  private readonly _createdById: string | null;
  private _resolvedById: string | null;
  private _resolvedAt: Date | null;
  private readonly _replies: CommentReply[];
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: CreateCommentThreadProps) {
    if (!props.projectId || !props.projectId.trim()) {
      throw new Error('Project ID cannot be empty.');
    }
    if (!props.docId || !props.docId.trim()) {
      throw new Error('Document ID cannot be empty.');
    }

    this._id = props.id ?? crypto.randomUUID();
    this._projectId = props.projectId;
    this._docId = props.docId;
    this._quote = props.quote ?? null;
    this._range = props.range;
    this._isResolved = props.isResolved ?? false;
    this._createdById = props.createdById ?? null;
    this._resolvedById = props.resolvedById ?? null;
    this._resolvedAt = props.resolvedAt ?? null;
    this._replies = props.replies ? [...props.replies] : [];
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CreateCommentThreadProps): CommentThread {
    return new CommentThread(props);
  }

  public get id(): string { return this._id; }
  public get projectId(): string { return this._projectId; }
  public get docId(): string { return this._docId; }
  public get quote(): string | null { return this._quote; }
  public get range(): TextRangeVo { return this._range; }
  public get isResolved(): boolean { return this._isResolved; }
  public get createdById(): string | null { return this._createdById; }
  public get resolvedById(): string | null { return this._resolvedById; }
  public get resolvedAt(): Date | null { return this._resolvedAt; }
  public get replies(): CommentReply[] { return [...this._replies]; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }

  public addReply(reply: CommentReply): void {
    if (this._isResolved) {
      throw new Error('Cannot add reply to a resolved comment thread.');
    }
    this._replies.push(reply);
    this._updatedAt = new Date();
  }

  public resolve(resolvedBy?: string | null): void {
    if (this._isResolved) {
      throw new Error('Comment thread is already resolved.');
    }
    this._isResolved = true;
    this._resolvedById = resolvedBy ?? null;
    this._resolvedAt = new Date();
    this._updatedAt = new Date();
  }

  public unresolve(): void {
    this._isResolved = false;
    this._resolvedById = null;
    this._resolvedAt = null;
    this._updatedAt = new Date();
  }

  public toJSON(): Record<string, any> {
    return {
      id: this._id,
      projectId: this._projectId,
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
