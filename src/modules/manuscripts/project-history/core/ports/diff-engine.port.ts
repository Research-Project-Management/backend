/**
 * project-history/core/ports/diff-engine.port.ts
 * Outbound Port (SPI) for Myers Diff calculation and inline word-level diff highlight generation.
 */

import { Snapshot } from '../domain/entities/snapshot.entity';
import { FileDiffVo } from '../domain/value-objects/file-diff.vo';
import { DiffHunkVo } from '../domain/value-objects/diff-hunk.vo';

export interface TextDiffResult {
  hunks: DiffHunkVo[];
  additions: number;
  deletions: number;
}

export abstract class IDiffEnginePort {
  /**
   * Compares two project snapshots and returns an array of FileDiffVo for each added, deleted, or modified file.
   */
  abstract compareSnapshots(baseSnapshot: Snapshot, targetSnapshot: Snapshot): FileDiffVo[];

  /**
   * Calculates Myers line diffs and word-level highlighting for two text line arrays.
   */
  abstract diffText(oldLines: string[], newLines: string[]): TextDiffResult;
}
