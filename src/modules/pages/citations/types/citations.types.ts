/**
 * citations/types/citations.types.ts
 * Shared domain types for the Citations & Bibliography module.
 */

import type { CitationKeyVo } from '../domain/value-objects.domain';

export type BibValueFormat = 'latex' | 'plain';

export type IdentifierType = 'doi' | 'arxiv' | 'isbn' | 'unknown';

export interface BibEntryProps {
  id?: string;
  key: string | CitationKeyVo;
  entryType: string;
  fields: Record<string, string>;
  rawBibtex?: string;
  valueFormat?: BibValueFormat;
}

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
