/**
 * project-history/core/domain/entities/snapshot.entity.ts
 * Domain Aggregate Entity representing an immutable project snapshot at a specific version.
 */

import * as crypto from 'node:crypto';
import { FileSnapshotVo } from '../value-objects/file-snapshot.vo';
import { VersionLabel } from './version-label.entity';
import { EmptyProjectException } from '../exceptions/empty-project.exception';

export interface CreateSnapshotProps {
  id?: string;
  projectId: string;
  version: number;
  summary?: string | null;
  createdById?: string | null;
  isAutomatic?: boolean;
  files: Map<string, FileSnapshotVo> | Record<string, any>;
  labels?: VersionLabel[];
  createdAt?: Date;
}

export class Snapshot {
  private readonly _id: string;
  private readonly _projectId: string;
  private readonly _version: number;
  private readonly _summary: string | null;
  private readonly _createdById: string | null;
  private readonly _isAutomatic: boolean;
  private readonly _files: Map<string, FileSnapshotVo>;
  private readonly _labels: VersionLabel[];
  private readonly _createdAt: Date;

  private constructor(props: CreateSnapshotProps) {
    this._id = props.id ?? crypto.randomUUID();
    this._projectId = props.projectId;
    this._version = props.version;
    this._summary = props.summary ?? null;
    this._createdById = props.createdById ?? null;
    this._isAutomatic = props.isAutomatic ?? false;
    this._labels = props.labels ? [...props.labels] : [];
    this._createdAt = props.createdAt ?? new Date();

    this._files = new Map<string, FileSnapshotVo>();
    if (props.files instanceof Map) {
      for (const [k, v] of props.files.entries()) {
        this._files.set(k, v);
      }
    } else if (typeof props.files === 'object' && props.files !== null) {
      for (const [k, v] of Object.entries(props.files)) {
        if (v instanceof FileSnapshotVo) {
          this._files.set(k, v);
        } else {
          this._files.set(k, FileSnapshotVo.fromProps(v));
        }
      }
    }

    if (this._files.size === 0) {
      throw new EmptyProjectException(this._projectId);
    }
  }

  public static create(props: CreateSnapshotProps): Snapshot {
    return new Snapshot(props);
  }

  public get id(): string { return this._id; }
  public get projectId(): string { return this._projectId; }
  public get version(): number { return this._version; }
  public get summary(): string | null { return this._summary; }
  public get createdById(): string | null { return this._createdById; }
  public get isAutomatic(): boolean { return this._isAutomatic; }
  public get files(): Map<string, FileSnapshotVo> { return new Map(this._files); }
  public get fileCount(): number { return this._files.size; }
  public get labels(): VersionLabel[] { return [...this._labels]; }
  public get createdAt(): Date { return this._createdAt; }

  public getFile(path: string): FileSnapshotVo | null {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return this._files.get(normalized) ?? null;
  }

  public addLabel(label: VersionLabel): void {
    this._labels.push(label);
  }

  public removeLabel(labelId: string): void {
    const idx = this._labels.findIndex((l) => l.id === labelId);
    if (idx >= 0) {
      this._labels.splice(idx, 1);
    }
  }

  public toFilesJson(): Record<string, any> {
    const record: Record<string, any> = {};
    for (const [path, fileVo] of this._files.entries()) {
      record[path] = fileVo.toJSON();
    }
    return record;
  }
}
