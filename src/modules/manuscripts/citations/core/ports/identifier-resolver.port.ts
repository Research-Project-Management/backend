/**
 * citations/core/ports/identifier-resolver.port.ts
 * Outbound SPI Port for resolving academic identifiers (DOI, arXiv) to structured BibTeX.
 */

import { AcademicIdentifierVo } from '../domain/value-objects/academic-identifier.vo';
import { BibEntry } from '../domain/entities/bib-entry.entity';

export const IDENTIFIER_RESOLVER_PORT = Symbol('IDENTIFIER_RESOLVER_PORT');

export interface IIdentifierResolverPort {
  /**
   * Resolves a DOI or arXiv identifier against CrossRef / arXiv public APIs.
   * Returns a populated BibEntry entity or null if not found.
   */
  resolve(identifier: AcademicIdentifierVo): Promise<BibEntry | null>;
}
