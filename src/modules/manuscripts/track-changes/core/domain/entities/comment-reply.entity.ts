/**
 * track-changes/core/domain/entities/comment-reply.entity.ts
 * Domain Entity representing a response message inside a CommentThread.
 */

import * as crypto from 'node:crypto';

export interface CreateCommentReplyProps {
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

  private constructor(props: CreateCommentReplyProps) {
    if (!props.content || !props.content.trim()) {
      throw new Error('Reply content cannot be empty.');
    }
    this._id = props.id ?? crypto.randomUUID();
    this._threadId = props.threadId;
    this._content = props.content.trim();
    this._createdById = props.createdById ?? null;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CreateCommentReplyProps): CommentReply {
    return new CommentReply(props);
  }

  public get id(): string { return this._id; }
  public get threadId(): string { return this._threadId; }
  public get content(): string { return this._content; }
  public get createdById(): string | null { return this._createdById; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }

  public updateContent(content: string): void {
    if (!content || !content.trim()) {
      throw new Error('Reply content cannot be empty.');
    }
    this._content = content.trim();
    this._updatedAt = new Date();
  }

  public toJSON(): Record<string, any> {
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
