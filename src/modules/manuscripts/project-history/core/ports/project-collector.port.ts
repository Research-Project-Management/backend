/**
 * project-history/core/ports/project-collector.port.ts
 * Outbound Port (SPI) for aggregating current live project files from Structure, Docstore, and Filestore.
 */

import { FileSnapshotVo } from '../domain/value-objects/file-snapshot.vo';

export abstract class IProjectCollectorPort {
  /**
   * Reads all current active files across Structure, Docstore, and Filestore
   * and builds an in-memory map of relative path -> FileSnapshotVo.
   */
  abstract collectCurrentState(projectId: string): Promise<Map<string, FileSnapshotVo>>;
}
