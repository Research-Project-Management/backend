/**
 * citations/core/ports/citations-aggregator.port.ts
 * Outbound SPI Port for discovering .bib files and writing entries via Structure & Docstore.
 */

import { BibliographyFile } from '../domain/entities/bibliography-file.entity';
import { BibEntry } from '../domain/entities/bib-entry.entity';

export const CITATIONS_AGGREGATOR_PORT = Symbol('CITATIONS_AGGREGATOR_PORT');

export interface ICitationsAggregatorPort {
  /**
   * Scans the project virtual tree for all *.bib files, loads their lines from Docstore,
   * and returns an array of parsed BibliographyFile entities.
   */
  collectBibFiles(projectId: string): Promise<BibliographyFile[]>;

  /**
   * Appends a newly resolved BibEntry to an existing or new .bib file in the project.
   * Returns the final path of the .bib file (e.g. '/references.bib').
   */
  appendEntryToBib(
    projectId: string,
    entry: BibEntry,
    targetFilename?: string
  ): Promise<string>;
}
