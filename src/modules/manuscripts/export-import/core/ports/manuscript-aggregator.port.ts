/**
 * export-import/core/ports/manuscript-aggregator.port.ts
 * Outbound Port (SPI) for collecting all project assets across structure, docstore, and filestore.
 */

export interface ExportableFileEntry {
  path: string;
  data?: Buffer;
  getData?: () => Promise<Buffer>;
  date?: Date;
}

export abstract class IManuscriptAggregatorPort {
  /**
   * Traverses the virtual file tree for a project, loads text lines from Docstore and
   * binary blobs from Filestore, and optionally includes the compiled output PDF.
   */
  abstract collectProjectEntries(
    projectId: string,
    includePdf?: boolean,
    cleanArxiv?: boolean,
  ): Promise<ExportableFileEntry[]>;

  /**
   * Lazily collects project entries for streaming export without preloading
   * file buffers upfront into memory.
   */
  abstract collectLazyProjectEntries(
    projectId: string,
    includePdf?: boolean,
    cleanArxiv?: boolean,
  ): Promise<ExportableFileEntry[]>;
}
