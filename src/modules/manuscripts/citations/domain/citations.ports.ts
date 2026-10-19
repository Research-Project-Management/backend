/**
 * citations/domain/citations.ports.ts
 * Domain port interfaces for Citations & Bibliography.
 */

import { BibEntry } from './entities/bib-entry.entity';
import { BibliographyFile } from './entities/bibliography-file.entity';
import { AcademicIdentifierVo } from './value-objects/academic-identifier.vo';

export interface IBibtexParserPort {
  /**
   * Parse a raw BibTeX string into an array of BibEntry entities.
   */
  parse(rawBibtex: string): BibEntry[];

  /**
   * Format an array of BibEntry entities into a valid BibTeX file string.
   */
  format(entries: BibEntry[]): string;
}

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
    targetFilename?: string,
  ): Promise<string>;
}

export interface IIdentifierResolverPort {
  /**
   * Resolves a DOI or arXiv identifier against CrossRef / arXiv public APIs.
   * Returns a populated BibEntry entity or null if not found.
   */
  resolve(identifier: AcademicIdentifierVo): Promise<BibEntry | null>;
}

export interface LibraryCollectionSummary {
  id: string;
  name: string;
  itemCount: number;
}

export interface ILibrarySyncPort {
  /**
   * List accessible reference collections for a given user.
   */
  listCollections(userId: string): Promise<LibraryCollectionSummary[]>;

  /**
   * Fetch all items in a collection serialized as a clean BibTeX stream.
   */
  fetchCollectionBibtex(userId: string, collectionId: string): Promise<string>;
}
