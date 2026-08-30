import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ItemMetadata } from '../types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
  normalizeIssn,
  normalizeTags,
  normalizeItemType,
  normalizeCreators,
  extractYearFromDate,
} from '../utils/metadata.utils';

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'in',
  'for',
  'with',
  'of',
  'and',
  'to',
  'from',
  'at',
  'by',
  'towards',
  'toward',
  'using',
  'through',
  'via',
  'novel',
  'new',
  'study',
  'analysis',
  'design',
  'based',
  'approach',
  'system',
  'method',
  'review',
  'survey',
  'evaluation',
  'framework',
  'modeling',
  'overview',
  'introduction',
  'perspective',
  'investigation',
]);

function stripDiacritics(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function extractFamilyName(rawAuthor: string): string {
  if (!rawAuthor || typeof rawAuthor !== 'string') return 'author';
  const clean = stripDiacritics(rawAuthor).trim();

  if (clean.includes(',')) {
    const last = clean.split(',')[0].trim();
    return last.toLowerCase().replace(/[^a-z0-9]/g, '') || 'author';
  }

  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'author';

  const last = tokens[tokens.length - 1];
  return last.toLowerCase().replace(/[^a-z0-9]/g, '') || 'author';
}

function extractMeaningfulTitleWord(title: string): string {
  if (!title || typeof title !== 'string') return 'item';
  const clean = stripDiacritics(title).toLowerCase();

  const words = clean.split(/[^a-z0-9]+/).filter(Boolean);

  for (const word of words) {
    if (!STOP_WORDS.has(word) && word.length >= 2) {
      return word;
    }
  }

  return words[0] || 'item';
}

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

  static fromDto(dto: any): ItemMetadata {
    return {
      title: dto.title ?? '',
      authors: dto.authors ?? [],
      creators: dto.creators ?? undefined,
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
    dto: any,
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
