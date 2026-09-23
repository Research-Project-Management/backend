/**
 * document-updater/core/ports/docstore-writer.port.ts
 * Outbound Port (SPI) for reading baseline documents and committing flushed line arrays into Docstore.
 */

export interface BaseDocData {
  docId: string;
  projectId: string;
  lines: string[];
  rev: number;
  version?: number;
}

export interface CommitResult {
  docId: string;
  newRev: number;
  version: number;
  hash: string;
}

export abstract class IDocstoreWriterPort {
  /**
   * Fetches the current persistent baseline document from docstore.
   */
  abstract fetchBaseDoc(projectId: string, docId: string): Promise<BaseDocData | null>;

  /**
   * Commits the flushed lines array and OCC rev into docstore.
   * Throws DocUpdaterConflictException if the underlying database rev has diverged.
   */
  abstract commitDocUpdate(
    projectId: string,
    docId: string,
    lines: string[],
    rev: number,
  ): Promise<CommitResult>;
}
