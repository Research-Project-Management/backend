/**
 * project-history/domain/project-history.ports.ts
 * Consolidated domain value objects (DiffHunkVo, FileDiffVo) and outbound ports
 * (IDiffEnginePort, IHistoryRepositoryPort, IProjectCollectorPort, IProjectRestorerPort)
 * for Project History.
 */

import { FileSnapshotType, FileSnapshotVo } from './file-snapshot';
import { Snapshot } from './snapshot.entity';
import { VersionLabel } from './version-label.entity';

export type LineDiffType = 'added' | 'deleted' | 'unchanged';
export type WordDiffType = 'added' | 'deleted' | 'unchanged';

export interface WordDiffToken {
  type: WordDiffType;
  text: string;
}

export interface DiffLine {
  type: LineDiffType;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  words?: WordDiffToken[];
}

export interface DiffHunkProps {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  lines: DiffLine[];
}

export class DiffHunkVo {
  public readonly oldStartLine: number;
  public readonly oldLineCount: number;
  public readonly newStartLine: number;
  public readonly newLineCount: number;
  public readonly lines: DiffLine[];

  constructor(props: DiffHunkProps) {
    this.oldStartLine = props.oldStartLine;
    this.oldLineCount = props.oldLineCount;
    this.newStartLine = props.newStartLine;
    this.newLineCount = props.newLineCount;
    this.lines = props.lines;
  }

  public get header(): string {
    return `@@ -${this.oldStartLine},${this.oldLineCount} +${this.newStartLine},${this.newLineCount} @@`;
  }
}

export type FileDiffStatus =
  'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged';

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

export interface TextDiffResult {
  hunks: DiffHunkVo[];
  additions: number;
  deletions: number;
}

export abstract class IDiffEnginePort {
  /**
   * Compares two project snapshots and returns an array of FileDiffVo for each added, deleted, or modified file.
   */
  abstract compareSnapshots(
    baseSnapshot: Snapshot,
    targetSnapshot: Snapshot,
  ): FileDiffVo[];

  /**
   * Calculates Myers line diffs and word-level highlighting for two text line arrays.
   */
  abstract diffText(oldLines: string[], newLines: string[]): TextDiffResult;
}

export abstract class IHistoryRepositoryPort {
  /**
   * Persists a new snapshot record and its attached labels.
   */
  abstract saveSnapshot(snapshot: Snapshot): Promise<Snapshot>;

  /**
   * Retrieves a snapshot by project and version number.
   */
  abstract findByVersion(
    projectId: string,
    version: number,
  ): Promise<Snapshot | null>;

  /**
   * Returns the highest version number recorded for this project (returns 0 if no snapshots exist).
   */
  abstract getLatestVersion(projectId: string): Promise<number>;

  /**
   * Lists all version snapshots for a project ordered by version ascending.
   */
  abstract listVersions(projectId: string): Promise<Snapshot[]>;

  /**
   * Saves or updates a version label.
   */
  abstract saveLabel(label: VersionLabel): Promise<VersionLabel>;

  /**
   * Deletes a version label by ID.
   */
  abstract deleteLabel(projectId: string, labelId: string): Promise<void>;

  /**
   * Finds a label by project and label string.
   */
  abstract findLabelByName(
    projectId: string,
    label: string,
  ): Promise<VersionLabel | null>;
}

export abstract class IProjectCollectorPort {
  /**
   * Reads all current active files across Structure, Docstore, and Filestore
   * and builds an in-memory map of relative path -> FileSnapshotVo.
   */
  abstract collectCurrentState(
    projectId: string,
  ): Promise<Map<string, FileSnapshotVo>>;
}

export interface RestoreResult {
  restoredFilesCount: number;
  restoredDocIds: string[];
}

export abstract class IProjectRestorerPort {
  /**
   * Applies the files and structure from an immutable snapshot onto the current project.
   */
  abstract restoreToState(
    projectId: string,
    snapshot: Snapshot,
  ): Promise<RestoreResult>;
}
