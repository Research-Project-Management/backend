/**
 * track-changes/core/ports/docstore-patcher.port.ts
 * Outbound Port (SPI) for applying or reverting text modifications on the persistent Docstore lines array.
 */

import { TrackChange } from '../domain/entities/track-change.entity';

export interface PatcherResult {
  lines: string[];
  newRev: number;
}

export abstract class IDocstorePatcherPort {
  /**
   * Applies the change permanently into Docstore:
   * - If 'insert': The inserted text is already in the document lines, so it is permanently accepted.
   * - If 'delete': Removes the text span from the document lines.
   */
  abstract applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult>;

  /**
   * Reverts the change in Docstore:
   * - If 'insert': Strips the inserted text out of the document lines.
   * - If 'delete': Restores the deleted text back into the document lines at the range.
   */
  abstract revertChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult>;
}
