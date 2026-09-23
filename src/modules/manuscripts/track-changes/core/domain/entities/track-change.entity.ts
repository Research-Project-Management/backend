/**
 * track-changes/core/domain/entities/track-change.entity.ts
 * Domain Aggregate Entity representing a proposed text modification (insert or delete).
 */

import * as crypto from 'node:crypto';
import { TextRangeVo } from '../value-objects/text-range.vo';

export type ChangeType = 'insert' | 'delete';
export type ChangeStatus = 'pending' | 'accepted' | 'rejected';

export interface CreateTrackChangeProps {
  id?: string;
  projectId: string;
  docId: string;
  type: ChangeType;
  status?: ChangeStatus;
  text: string;
  range: TextRangeVo;
  createdById?: string | null;
  resolvedById?: string | null;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class TrackChange {
  private readonly _id: string;
  private readonly _projectId: string;
  private readonly _docId: string;
  private readonly _type: ChangeType;
  private _status: ChangeStatus;
  private readonly _text: string;
  private readonly _range: TextRangeVo;
  private readonly _createdById: string | null;
  private _resolvedById: string | null;
  private _resolvedAt: Date | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: CreateTrackChangeProps) {
    if (!props.projectId || !props.projectId.trim()) {
      throw new Error('Project ID cannot be empty.');
    }
    if (!props.docId || !props.docId.trim()) {
      throw new Error('Document ID cannot be empty.');
    }

    this._id = props.id ?? crypto.randomUUID();
    this._projectId = props.projectId;
    this._docId = props.docId;
    this._type = props.type;
    this._status = props.status ?? 'pending';
    this._text = props.text;
    this._range = props.range;
    this._createdById = props.createdById ?? null;
    this._resolvedById = props.resolvedById ?? null;
    this._resolvedAt = props.resolvedAt ?? null;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CreateTrackChangeProps): TrackChange {
    return new TrackChange(props);
  }

  public get id(): string { return this._id; }
  public get projectId(): string { return this._projectId; }
  public get docId(): string { return this._docId; }
  public get type(): ChangeType { return this._type; }
  public get status(): ChangeStatus { return this._status; }
  public get text(): string { return this._text; }
  public get range(): TextRangeVo { return this._range; }
  public get createdById(): string | null { return this._createdById; }
  public get resolvedById(): string | null { return this._resolvedById; }
  public get resolvedAt(): Date | null { return this._resolvedAt; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }

  public isPending(): boolean {
    return this._status === 'pending';
  }

  public accept(resolvedBy?: string | null): void {
    if (!this.isPending()) {
      throw new Error(`Change '${this._id}' has already been ${this._status}.`);
    }
    this._status = 'accepted';
    this._resolvedById = resolvedBy ?? null;
    this._resolvedAt = new Date();
    this._updatedAt = new Date();
  }

  public reject(resolvedBy?: string | null): void {
    if (!this.isPending()) {
      throw new Error(`Change '${this._id}' has already been ${this._status}.`);
    }
    this._status = 'rejected';
    this._resolvedById = resolvedBy ?? null;
    this._resolvedAt = new Date();
    this._updatedAt = new Date();
  }

  public toJSON(): Record<string, any> {
    return {
      id: this._id,
      projectId: this._projectId,
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
