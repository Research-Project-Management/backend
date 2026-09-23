/**
 * export-import/core/ports/manuscript-hydrator.port.ts
 * Outbound Port (SPI) for reconstituting an imported archive into structure, docstore, and filestore.
 */

import { ArchiveEntryVo } from '../domain/value-objects/archive-entry.vo';
import { ImportSummaryVo } from '../domain/value-objects/import-summary.vo';

export abstract class IManuscriptHydratorPort {
  /**
   * Persists extracted archive entries into virtual folder hierarchy, docstore text lines,
   * and filestore binary media blobs, then automatically detects and configures the root document.
   */
  abstract hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
  ): Promise<ImportSummaryVo>;
}
