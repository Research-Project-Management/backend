/**
 * project-history/core/domain/value-objects/file-diff.vo.ts
 * Value Object summarizing diff comparison for a specific file between version A and version B.
 */

import { DiffHunkVo } from './diff-hunk.vo';
import { FileSnapshotType } from './file-snapshot.vo';

export type FileDiffStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged';

export interface FileDiffProps {
  path: string;
  status: FileDiffStatus;
  type: FileSnapshotType;
  oldPath?: string;
  oldHash?: string;
  newHash?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunkVo[];
}

export class FileDiffVo {
  public readonly path: string;
  public readonly status: FileDiffStatus;
  public readonly type: FileSnapshotType;
  public readonly oldPath?: string;
  public readonly oldHash?: string;
  public readonly newHash?: string;
  public readonly additions: number;
  public readonly deletions: number;
  public readonly hunks: DiffHunkVo[];

  constructor(props: FileDiffProps) {
    this.path = props.path;
    this.status = props.status;
    this.type = props.type;
    this.oldPath = props.oldPath;
    this.oldHash = props.oldHash;
    this.newHash = props.newHash;
    this.additions = props.additions;
    this.deletions = props.deletions;
    this.hunks = props.hunks;
  }
}
