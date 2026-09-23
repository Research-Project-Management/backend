/**
 * project-history/core/domain/entities/version-label.entity.ts
 * Domain Entity representing a user-assigned named label for a project version.
 */

import * as crypto from 'node:crypto';

export interface CreateVersionLabelProps {
  id?: string;
  projectId: string;
  snapshotId: string;
  version: number;
  label: string;
  createdById?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class VersionLabel {
  private readonly _id: string;
  private readonly _projectId: string;
  private readonly _snapshotId: string;
  private readonly _version: number;
  private _label: string;
  private readonly _createdById?: string | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: CreateVersionLabelProps) {
    if (!props.label || !props.label.trim()) {
      throw new Error('Version label cannot be empty.');
    }
    this._id = props.id ?? crypto.randomUUID();
    this._projectId = props.projectId;
    this._snapshotId = props.snapshotId;
    this._version = props.version;
    this._label = props.label.trim();
    this._createdById = props.createdById ?? null;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CreateVersionLabelProps): VersionLabel {
    return new VersionLabel(props);
  }

  public get id(): string { return this._id; }
  public get projectId(): string { return this._projectId; }
  public get snapshotId(): string { return this._snapshotId; }
  public get version(): number { return this._version; }
  public get label(): string { return this._label; }
  public get createdById(): string | null | undefined { return this._createdById; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }

  public updateLabel(newLabel: string): void {
    if (!newLabel || !newLabel.trim()) {
      throw new Error('Version label cannot be empty.');
    }
    this._label = newLabel.trim();
    this._updatedAt = new Date();
  }
}
