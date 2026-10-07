export type SupportedCitationStyle =
  | 'apa'
  | 'harvard'
  | 'vancouver'
  | 'ieee'
  | 'chicago'
  | 'nature'
  | 'science'
  | (string & {});

export type CitationStyleId =
  | 'apa'
  | 'apa-7th'
  | 'ieee'
  | 'nature'
  | 'harvard'
  | 'chicago'
  | 'chicago-author-date'
  | 'mla'
  | 'mla-9th'
  | 'vancouver'
  | 'bibtex'
  | 'ris'
  | (string & {});

export interface CitationCreator {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  creatorType?: string | null;
}

export interface CitationItemInput {
  id?: string;
  itemType: string;
  title: string;
  creators?: CitationCreator[];
  authors?: string[];
  publicationTitle?: string | null;
  journal?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  year?: number | null;
  date?: string | null;
  doi?: string | null;
  url?: string | null;
  citationKey?: string | null;
  city?: string | null;
  edition?: string | null;
  abstract?: string | null;
  /** Last modification timestamp; used to invalidate the CSL engine render cache. */
  updatedAt?: Date | string | null;
  /** Optional optimistic-lock / revision number; also part of the render cache key. */
  version?: number | string | null;
}

export interface FormattedCitationResult {
  styleId?: CitationStyleId;
  style?: string;
  itemId?: string;
  formattedText?: string;
  inText?: string;
  bibliography?: string;
  bibliographyHtml?: string;
  source?: 'publisher' | 'csl-engine' | string;
}

export interface ReferenceData {
  doi?: string;
  title: string;
  authors?: string[];
  creators?: Array<{
    creatorType?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  }>;
  year?: number | string;
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  openAccessPdfUrl?: string;
  abstract?: string;
  citationCount?: number | string | null;
  keywords?: string[];
  tags?: string[];
  type?: string;
  itemType?: string;
  containerTitle?: string;
  score?: number;
  extraFields?: Record<string, unknown>;
  provenance?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * CitationStyle Value Object validating academic citation styles.
 * Supports any valid style slug from the 10,000+ CSL repository.
 */
export class CitationStyleVo {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value;
  }

  public static create(rawStyle?: string | null): CitationStyleVo {
    if (!rawStyle) return new CitationStyleVo('apa');
    const cleaned = rawStyle
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    if (!cleaned) {
      return new CitationStyleVo('apa');
    }
    return new CitationStyleVo(cleaned);
  }

  public get value(): string {
    return this._value;
  }

  public equals(other?: CitationStyleVo | null): boolean {
    if (!other) return false;
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}

export const CITATION_ENGINE_PORT = Symbol('CITATION_ENGINE_PORT');

export interface ICitationEnginePort {
  formatItem(
    userId: string,
    itemId: string,
    style: CitationStyleVo,
  ): Promise<FormattedCitationResult | null>;
  formatBatch(
    userId: string,
    itemIds: string[],
    style: CitationStyleVo,
  ): Promise<FormattedCitationResult[]>;
}

export const CATALOG_GATEWAY_PORT = Symbol('CITATION_CATALOG_GATEWAY_PORT');

export interface ICatalogGatewayPort {
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null>;

  findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]>;
}
