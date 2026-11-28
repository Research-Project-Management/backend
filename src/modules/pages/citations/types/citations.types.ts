/**
 * citations/types/citations.types.ts
 * Shared domain types for the Citations & Bibliography module.
 */

export type { BibEntryProps, BibValueFormat } from '../domain/bib-entry.domain';
export type { IdentifierType } from '../domain/value-objects.domain';

export interface StructuredCitationEntryInput {
  id?: string;
  key?: string;
  citationKey?: string;
  entryType?: string;
  type?: string;
  itemType?: string;
  title?: string;
  author?: string;
  authors?: string[];
  contributors?: Array<{
    name?: string | null;
    fullName?: string | null;
    lastName?: string | null;
    firstName?: string | null;
    literal?: string | null;
    fieldMode?: number | null;
  }>;
  year?: string | number;
  date?: string;
  journal?: string;
  publicationTitle?: string;
  booktitle?: string;
  publisher?: string;
  volume?: string;
  number?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  abstractNote?: string;
  raw?: string;
  rawBibtex?: string;
  fields?: Record<string, string>;
}
