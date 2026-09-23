/**
 * export-import/core/ports/manuscript-aggregator.port.ts
 * Outbound Port (SPI) for collecting all project assets across structure, docstore, and filestore.
 */

export interface ExportableFileEntry {
  path: string;
  data: Buffer;
}

export abstract class IManuscriptAggregatorPort {
  /**
   * Traverses the virtual file tree for a project, loads text lines from Docstore and
   * binary blobs from Filestore, and optionally includes the compiled output PDF.
   */
  abstract collectProjectEntries(
    projectId: string,
    includePdf?: boolean,
  ): Promise<ExportableFileEntry[]>;
}
