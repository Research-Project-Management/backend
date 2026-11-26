import type { FileSnapshotVo, Snapshot } from './snapshot';
import type { VersionLabel } from './label';
import type { FileDiffVo, TextDiffResult } from './diff';

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
    pageId?: string,
  ): Promise<Snapshot | null>;

  /**
   * Returns the highest version number recorded for this project/page (returns 0 if no snapshots exist).
   */
  abstract getLatestVersion(
    projectId: string,
    pageId?: string,
  ): Promise<number>;

  /**
   * Lists all version snapshots for a project/page ordered by version ascending.
   */
  abstract listVersions(
    projectId: string,
    pageId?: string,
  ): Promise<Snapshot[]>;

  /**
   * Saves or updates a version label.
   */
  abstract saveLabel(label: VersionLabel): Promise<VersionLabel>;

  /**
   * Deletes a version label by ID.
   */
  abstract deleteLabel(
    projectId: string,
    labelId: string,
    pageId?: string,
  ): Promise<void>;

  /**
   * Finds a label by project/page and label string.
   */
  abstract findLabelByName(
    projectId: string,
    label: string,
    pageId?: string,
  ): Promise<VersionLabel | null>;
}

export abstract class ISnapshotCollectorPort {
  /**
   * Reads all current active files across Structure, Docstore, and Filestore
   * and builds an in-memory map of relative path -> FileSnapshotVo.
   */
  abstract collectCurrentState(
    projectId: string,
    pageId?: string,
  ): Promise<Map<string, FileSnapshotVo>>;
}

export interface RestoreResult {
  restoredFilesCount: number;
  restoredDocIds: string[];
}

export interface RestoreSingleFileResult {
  path: string;
  docId?: string | null;
  fileId?: string | null;
  content?: string;
  rev?: number;
}

export abstract class ISnapshotRestorerPort {
  /**
   * Applies the files and structure from an immutable snapshot onto the current project/page.
   */
  abstract restoreToState(
    projectId: string,
    snapshot: Snapshot,
    pageId?: string,
  ): Promise<RestoreResult>;

  /**
   * Restores a single file from an immutable snapshot onto the current project/page.
   */
  abstract restoreSingleFileToState?(
    projectId: string,
    snapshot: Snapshot,
    pathname: string,
    hintFileId?: string,
    pageId?: string,
  ): Promise<RestoreSingleFileResult>;
}