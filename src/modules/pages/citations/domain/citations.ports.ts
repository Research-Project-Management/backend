/**
 * citations/domain/citations.ports.ts
 * Domain port interfaces for Citations & Bibliography.
 */

import { BibEntry, BibliographyFile } from './bib-entry.domain';
import { IdentifierVo } from './value-objects.domain';

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
  collectBibFiles(spaceId: string): Promise<BibliographyFile[]>;

  appendEntriesToBib(
    spaceId: string,
    entries: BibEntry[],
    targetFilename?: string,
    pageId?: string,
  ): Promise<{ filePath: string; docId?: string; conflicts: string[] }>;
}

export interface IIdentifierResolverPort {
  /**
   * Resolves a DOI or arXiv identifier against CrossRef / arXiv public APIs.
   * Returns a populated BibEntry entity or null if not found.
   */
  resolve(identifier: IdentifierVo): Promise<BibEntry | null>;
}

export interface ILibrarySyncPort {
  /**
   * Fetch all items in a collection serialized as a clean BibTeX stream.
   */
  fetchCollectionBibtex(userId: string, collectionId: string): Promise<string>;
}
