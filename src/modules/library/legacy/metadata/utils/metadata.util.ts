import { Logger, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  extractFamilyName,
  extractMeaningfulTitleWord,
} from '../../cite/utils/cite.util';
import {
  extractYearFromDate,
  normalizeCreators,
  normalizeItemType,
  normalizeTags,
  ItemMetadata,
} from '../types/metadata.types';
import { IngestDocumentDto } from '../../translation/dto/translation.dto';

/* -------------------------------------------------------------------------- */
/*                     1. IDENTIFIER NORMALIZATION                            */
/* -------------------------------------------------------------------------- */

export function validateMetadata(metadata: unknown): ItemMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const raw = metadata as ItemMetadata;
  const title = raw.title?.trim();
  if (!title) return null;

  const normalized: ItemMetadata = {
    ...raw,
    title,
    authors: Array.isArray(raw.authors)
      ? raw.authors.map((author) => author.trim()).filter(Boolean)
      : undefined,
    year: typeof raw.year === 'string' ? parseInt(raw.year, 10) : raw.year,
    doi: normalizeDoi(raw.doi),
    arxivId: normalizeArxivId(raw.arxivId),
    pmid: normalizePmid(raw.pmid),
    pmcid: normalizePmcid(raw.pmcid),
    isbn: normalizeIsbn(raw.isbn),
    issn: normalizeIssn(raw.issn),
    tags: normalizeTags(raw.tags ?? raw.keywords),
    keywords: normalizeTags(raw.keywords),
  };

  if (raw.provenance) {
    normalized.provenance = {
      ...raw.provenance,
      resolvedAt: raw.provenance.resolvedAt ?? new Date().toISOString(),
      confidenceScore: raw.provenance.confidenceScore ?? 1,
      isOpenAccess: raw.provenance.isOpenAccess ?? false,
    };
  }

  return normalized;
}
export const validateAcademicMetadata = validateMetadata;

export function normalizeDoi(doi?: string | null): string | undefined {
  if (!doi || typeof doi !== 'string') return undefined;
  let clean = doi.trim();

  clean = clean.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  clean = clean.replace(/[.,;)\]]+$/, '');

  const match = clean.match(/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/);
  if (!match) {
    const embedded = clean.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
    return embedded ? embedded[0].toLowerCase() : undefined;
  }

  return clean.toLowerCase();
}

export function normalizeArxivId(
  arxiv?: string | null,
  options?: { stripVersion?: boolean },
): string | undefined {
  if (!arxiv || typeof arxiv !== 'string') return undefined;
  let clean = arxiv.trim();

  clean = clean.replace(
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i,
    '',
  );
  clean = clean.replace(/\.pdf$/i, '');
  if (options?.stripVersion) {
    clean = clean.replace(/v\d+$/i, '');
  }

  const newFormat = clean.match(/^\d{4}\.\d{4,5}(?:v\d+)?$/i);
  if (newFormat) return newFormat[0];

  const oldFormat = clean.match(/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/i);
  if (oldFormat) return oldFormat[0].toLowerCase();

  return undefined;
}

export function formatCanonicalId(
  scheme: 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn',
  value?: string | number | null,
): string | undefined {
  const normalized = {
    doi: normalizeDoi(typeof value === 'number' ? String(value) : value),
    arxiv: normalizeArxivId(typeof value === 'number' ? String(value) : value),
    pmid: normalizePmid(value),
    pmcid: normalizePmcid(typeof value === 'number' ? String(value) : value),
    isbn: normalizeIsbn(typeof value === 'number' ? String(value) : value),
    issn: normalizeIssn(typeof value === 'number' ? String(value) : value),
  }[scheme];

  return normalized ? `${scheme}:${normalized}` : undefined;
}

export function normalizePmid(
  pmid?: string | number | null,
): string | undefined {
  if (pmid === null || pmid === undefined) return undefined;
  const str = String(pmid)
    .trim()
    .replace(/^(?:pmid:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)/i, '')
    .replace(/\/$/, '');
  return /^\d{1,9}$/.test(str) ? str : undefined;
}

export function normalizePmcid(pmcid?: string | null): string | undefined {
  if (!pmcid || typeof pmcid !== 'string') return undefined;
  const clean = pmcid
    .trim()
    .toUpperCase()
    .replace(
      /^(?:PMCID:\s*|PMC:\s*|HTTPS?:\/\/WWW\.NCBI\.NLM\.NIH\.GOV\/PMC\/ARTICLES\/)/i,
      '',
    )
    .replace(/\/$/, '');
  const digits = clean.replace(/^PMC/, '');
  return /^\d{1,9}$/.test(digits) ? `PMC${digits}` : undefined;
}

export function normalizeIsbn(isbn?: string | null): string | undefined {
  if (!isbn || typeof isbn !== 'string') return undefined;
  const digits = isbn
    .replace(/^isbn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^(?:978|979)\d{10}$/.test(digits) || /^\d{9}[\dX]$/.test(digits)) {
    return digits;
  }
  return undefined;
}

export function normalizeIssn(issn?: string | null): string | undefined {
  if (!issn || typeof issn !== 'string') return undefined;
  const clean = issn
    .replace(/^issn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^\d{7}[\dX]$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*                       2. QUERY CLASSIFIER                                  */
/* -------------------------------------------------------------------------- */

export type QueryType = 'DOI' | 'ARXIV' | 'PMID' | 'ISBN' | 'URL' | 'TITLE';
export type AcademicQueryType = QueryType;

export interface ClassifiedQuery {
  raw: string;
  clean: string;
  type: QueryType;
}

export class QueryClassifier {
  private static readonly DOI_REGEX =
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)$/i;

  private static readonly ARXIV_REGEX =
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:\.pdf)?$/i;

  private static readonly PMID_REGEX =
    /^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|pmid:\s*)?(\d{1,9})\/?$/i;

  private static readonly ISBN_REGEX =
    /^(?:isbn:?\s*|urn:isbn:)?(97[89][-\s]?(?:\d[-\s]?){9}\d|(?:\d[-\s]?){9}[\dX])$/i;

  private static readonly GENERIC_URL_REGEX = /^https?:\/\/[^\s$.?#].[^\s]*$/i;

  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();

    const doiMatch = trimmed.match(this.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return { raw: trimmed, clean: doiMatch[1], type: 'DOI' };
    }

    const arxivMatch = trimmed.match(this.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return { raw: trimmed, clean: arxivMatch[1], type: 'ARXIV' };
    }

    const pmidMatch = trimmed.match(this.PMID_REGEX);
    if (pmidMatch && pmidMatch[1]) {
      return { raw: trimmed, clean: pmidMatch[1], type: 'PMID' };
    }

    const isbnMatch = trimmed.match(this.ISBN_REGEX);
    if (isbnMatch && isbnMatch[1]) {
      return {
        raw: trimmed,
        clean: isbnMatch[1].replace(/[-\s]/g, ''),
        type: 'ISBN',
      };
    }

    if (this.GENERIC_URL_REGEX.test(trimmed)) {
      return { raw: trimmed, clean: trimmed, type: 'URL' };
    }

    return { raw: trimmed, clean: trimmed, type: 'TITLE' };
  }
}
export const QueryClassifierUtil = QueryClassifier;

/* -------------------------------------------------------------------------- */
/*                    3. IN-MEMORY CIRCUIT BREAKER                            */
/* -------------------------------------------------------------------------- */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

interface CircuitRecord {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  lastStateChange: number;
}

export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private readonly records = new Map<string, CircuitRecord>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.cooldownMs = options?.cooldownMs ?? 30_000;
  }

  private getRecord(provider: string): CircuitRecord {
    let rec = this.records.get(provider);
    if (!rec) {
      rec = {
        state: 'CLOSED',
        failureCount: 0,
        lastFailureTime: 0,
        lastStateChange: Date.now(),
      };
      this.records.set(provider, rec);
    }
    return rec;
  }

  canExecute(provider: string): boolean {
    const rec = this.getRecord(provider);
    const now = Date.now();

    if (rec.state === 'CLOSED') return true;

    if (rec.state === 'OPEN') {
      if (now - rec.lastFailureTime >= this.cooldownMs) {
        rec.state = 'HALF_OPEN';
        rec.lastStateChange = now;
        this.logger.log(`Circuit for "${provider}" transitioned to HALF_OPEN`);
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(provider: string): void {
    const rec = this.getRecord(provider);
    if (rec.state !== 'CLOSED') {
      this.logger.log(`Circuit for "${provider}" recovered -> CLOSED`);
    }
    rec.state = 'CLOSED';
    rec.failureCount = 0;
    rec.lastStateChange = Date.now();
  }

  recordFailure(provider: string, error?: unknown): void {
    const rec = this.getRecord(provider);
    const now = Date.now();
    rec.failureCount += 1;
    rec.lastFailureTime = now;

    if (rec.state === 'CLOSED' && rec.failureCount >= this.failureThreshold) {
      rec.state = 'OPEN';
      rec.lastStateChange = now;
      this.logger.warn(
        `Circuit for "${provider}" TRIPPED to OPEN after ${rec.failureCount} consecutive failures. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else if (rec.state === 'HALF_OPEN') {
      rec.state = 'OPEN';
      rec.lastStateChange = now;
    }
  }

  async execute<T>(
    provider: string,
    operation: () => Promise<T | null>,
  ): Promise<T | null> {
    if (!this.canExecute(provider)) {
      return null;
    }

    try {
      const result = await operation();
      if (result !== null && result !== undefined) {
        this.recordSuccess(provider);
      }
      return result;
    } catch (err) {
      this.recordFailure(provider, err);
      return null;
    }
  }
}
export const ProviderCircuitBreaker = CircuitBreaker;

/* -------------------------------------------------------------------------- */
/*                    4. METADATA REDUCER                                     */
/* -------------------------------------------------------------------------- */
@Injectable()
export class MetadataReducer {
  static cleanFilenameForTitleSearch(filename: string): string {
    if (!filename) return 'Untitled Item';
    return filename
      .replace(/\.[^/.]+$/, '')
      .replace(/^[A-Z][A-Za-z]+(?:19|20)\d{2}[^_-]*[_-]/, '')
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .trim();
  }

  static fromDto(dto: Partial<IngestDocumentDto>): ItemMetadata {
    return {
      title: dto.title ?? '',
      authors: dto.authors ?? [],
      creators: (dto.creators as any) ?? undefined,
      year: dto.year ?? undefined,
      date: dto.date ?? undefined,
      journal: dto.journal ?? undefined,
      publisher: dto.publisher ?? undefined,
      volume: dto.volume ?? undefined,
      issue: dto.issue ?? undefined,
      pages: dto.pages ?? undefined,
      abstract: (dto.abstract || dto.abstractNote) ?? undefined,
      doi: normalizeDoi(dto.doi),
      isbn: normalizeIsbn(dto.isbn),
      issn: normalizeIssn(dto.issn),
      url: dto.url ?? undefined,
      itemType: normalizeItemType(dto.itemType),
      citationKey: dto.citationKey ?? undefined,
      explicitCitationKey: dto.citationKey ?? undefined,
      filename: dto.filename ?? 'document.pdf',
      tags: normalizeTags(dto.tags),
      labels: normalizeTags(dto.tags),
      notes: [],
    };
  }

  static merge(
    primary: ItemMetadata,
    supplemental?: Partial<ItemMetadata>,
  ): ItemMetadata & { notes: Array<{ content: string; source?: string }> } {
    const result: ItemMetadata = {
      ...primary,
      authors: primary.authors ? [...primary.authors] : [],
      labels: primary.labels ? [...primary.labels] : [],
      tags: primary.tags ? [...primary.tags] : [],
      notes: primary.notes ? [...primary.notes] : [],
    };

    if (!supplemental) {
      return result as ItemMetadata & {
        notes: Array<{ content: string; source?: string }>;
      };
    }

    if (!result.title && supplemental.title) result.title = supplemental.title;
    if (
      (!result.authors || result.authors.length === 0) &&
      supplemental.authors?.length
    ) {
      result.authors = [...supplemental.authors];
    }
    if (!result.year && supplemental.year) result.year = supplemental.year;
    if (!result.journal && supplemental.journal)
      result.journal = supplemental.journal;
    if (!result.doi && supplemental.doi) result.doi = supplemental.doi;
    if (!result.citationKey && supplemental.citationKey)
      result.citationKey = supplemental.citationKey;
    if (!result.explicitCitationKey && supplemental.citationKey) {
      result.explicitCitationKey = supplemental.citationKey;
    }
    if (
      !result.fileUrl &&
      (supplemental.fileUrl || supplemental.openAccessPdfUrl)
    ) {
      result.fileUrl = supplemental.fileUrl || supplemental.openAccessPdfUrl;
    }
    if (supplemental.keywords?.length) {
      result.labels = normalizeTags([
        ...(result.labels || []),
        ...supplemental.keywords,
      ]);
    }
    if (supplemental.tags?.length) {
      result.tags = normalizeTags([
        ...(result.tags || []),
        ...supplemental.tags,
      ]);
    }
    if (supplemental.tldr) {
      result.notes = [
        ...(result.notes || []),
        { content: supplemental.tldr, source: 'metadata' },
      ];
    }

    return result as ItemMetadata & {
      notes: Array<{ content: string; source?: string }>;
    };
  }

  static mergeBibtex(
    primary: ItemMetadata,
    bibtexEntry: Partial<ItemMetadata> & { annote?: string },
  ): ItemMetadata & { notes: Array<{ content: string; source?: string }> } {
    const merged = MetadataReducer.merge(primary, bibtexEntry);
    if (bibtexEntry.citationKey) {
      merged.explicitCitationKey = bibtexEntry.citationKey;
      merged.citationKey = bibtexEntry.citationKey;
    }
    if (bibtexEntry.annote) {
      merged.notes = [
        ...(merged.notes || []),
        { content: bibtexEntry.annote, source: 'bibtex' },
      ];
    }
    return merged;
  }

  reduce(
    primary: ItemMetadata,
    supplemental?: Partial<ItemMetadata>,
    userOverrides?: Partial<ItemMetadata>,
  ): ItemMetadata {
    const result: ItemMetadata = { ...primary };

    if (supplemental) {
      if (!result.title && supplemental.title)
        result.title = supplemental.title;
      if (
        (!result.authors || result.authors.length === 0) &&
        supplemental.authors?.length
      ) {
        result.authors = supplemental.authors;
      }
      if (
        (!result.creators || result.creators.length === 0) &&
        supplemental.creators?.length
      ) {
        result.creators = supplemental.creators;
      }
      if (!result.year && supplemental.year) result.year = supplemental.year;
      if (!result.abstract && supplemental.abstract)
        result.abstract = supplemental.abstract;
      if (!result.journal && supplemental.journal)
        result.journal = supplemental.journal;
      if (!result.publisher && supplemental.publisher)
        result.publisher = supplemental.publisher;
      if (!result.doi && supplemental.doi)
        result.doi = normalizeDoi(supplemental.doi);
      if (!result.arxivId && supplemental.arxivId)
        result.arxivId = normalizeArxivId(supplemental.arxivId);
      if (!result.pmid && supplemental.pmid)
        result.pmid = normalizePmid(supplemental.pmid);
      if (!result.isbn && supplemental.isbn)
        result.isbn = normalizeIsbn(supplemental.isbn);
      if (!result.url && supplemental.url) result.url = supplemental.url;
      if (!result.pdfUrl && supplemental.pdfUrl)
        result.pdfUrl = supplemental.pdfUrl;

      if (supplemental.tags?.length) {
        result.tags = normalizeTags([
          ...(result.tags || []),
          ...supplemental.tags,
        ]);
      }
    }

    if (userOverrides) {
      Object.assign(result, userOverrides);
    }

    if (result.doi) result.doi = normalizeDoi(result.doi);
    if (result.arxivId) result.arxivId = normalizeArxivId(result.arxivId);
    if (result.pmid) result.pmid = normalizePmid(result.pmid);
    if (result.isbn) result.isbn = normalizeIsbn(result.isbn);
    if (result.issn) result.issn = normalizeIssn(result.issn);

    if (!result.year && result.date) {
      result.year = extractYearFromDate(result.date);
    }

    result.creators = normalizeCreators(result.creators, result.authors);
    result.itemType = normalizeItemType(result.itemType);
    result.tags = normalizeTags(result.tags);

    return result;
  }

  buildCreateInput(
    workspaceId: string,
    userId: string,
    metadata: ItemMetadata,
    dto: IngestDocumentDto,
  ) {
    const finalTitle = (
      metadata.title ||
      dto.title ||
      'Untitled Document'
    ).trim();
    const finalYear =
      metadata.year ||
      dto.year ||
      extractYearFromDate(dto.date || metadata.date);
    const finalItemType = normalizeItemType(dto.itemType || metadata.itemType);
    const finalCreators = normalizeCreators(
      dto.creators || metadata.creators,
      dto.authors || metadata.authors,
    );
    const authorNames = finalCreators.map(
      (c) =>
        c.name || [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
    );

    const firstAuthor = authorNames[0] || 'Unknown';
    const citationKey =
      dto.citationKey ||
      metadata.citationKey ||
      `${extractFamilyName(firstAuthor)}${finalYear || ''}${extractMeaningfulTitleWord(finalTitle)}`;

    return {
      id: randomUUID(),
      workspaceId,
      uploadedById: userId,
      title: finalTitle,
      type: finalItemType,
      authors: authorNames,
      year: finalYear,
      journal: metadata.journal || dto.journal,
      publisher: metadata.publisher || dto.publisher,
      volume: metadata.volume || dto.volume,
      issue: metadata.issue || dto.issue,
      pages: metadata.pages || dto.pages,
      abstract: metadata.abstract || dto.abstract || dto.abstractNote,
      doi: normalizeDoi(metadata.doi || dto.doi),
      arxivId: normalizeArxivId(metadata.arxivId),
      pmid: normalizePmid(metadata.pmid),
      isbn: normalizeIsbn(metadata.isbn || dto.isbn),
      issn: normalizeIssn(metadata.issn || dto.issn),
      url: metadata.url || dto.url,
      citationKey,
      labels: normalizeTags(dto.tags || metadata.tags),
      extra: metadata.extra,
      ...(dto.collectionId && {
        collection: { connect: { id: dto.collectionId } },
      }),
    };
  }
}
export const AcademicMetadataReducer = MetadataReducer;
