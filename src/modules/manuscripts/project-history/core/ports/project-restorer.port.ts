/**
 * project-history/core/ports/project-restorer.port.ts
 * Outbound Port (SPI) for applying a historical snapshot back into Structure and Docstore.
 */

import { Snapshot } from '../domain/entities/snapshot.entity';

export interface RestoreResult {
  restoredFilesCount: number;
  restoredDocIds: string[];
}

export abstract class IProjectRestorerPort {
  /**
   * Applies the files and structure from an immutable snapshot onto the current project.
   */
  abstract restoreToState(projectId: string, snapshot: Snapshot): Promise<RestoreResult>;
}
