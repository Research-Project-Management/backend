/**
 * citations/core/ports/bibtex-parser.port.ts
 * Outbound SPI Port for parsing and serializing BibTeX bibliography files.
 */

import { BibEntry } from '../domain/entities/bib-entry.entity';

export const BIBTEX_PARSER_PORT = Symbol('BIBTEX_PARSER_PORT');

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
