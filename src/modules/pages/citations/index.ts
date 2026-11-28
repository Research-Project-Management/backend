/**
 * modules/pages/citations/index.ts
 * Public entry point for the Pages Citations & Bibliography module.
 */

export {
  BibMutationResponseDto,
  CitationEntryDto,
  CitationQueryDto,
  ListCitationsResponseDto,
  ResolveIdentifierDto,
  SyncLibraryDto,
  UpsertCitationEntriesDto,
} from './dto/citations.dto';
export {
  BibEntry,
  BibliographyFile,
  buildBibEntryFromInput,
  matchesCitationQuery,
  type BibEntryProps,
  type BibValueFormat,
} from './domain/bib-entry.domain';
export {
  BibtexParser,
  escapeLatex,
  formatBibtexName,
  sanitizeCitationKey,
  toBibtexValue,
  type ConflictPolicy,
  type ToBibtexValueOptions,
} from './domain/bibtex.domain';
export {
  IdentifierNotFoundException,
  InvalidBibtexException,
} from './domain/citations.errors';
export type {
  IdentifierType,
  StructuredCitationEntryInput,
} from './types/citations.types';
export { CitationsService } from './services/citations.service';
export { CitationIndexService } from './services/index.service';
export { CitationsModule } from './citations.module';
