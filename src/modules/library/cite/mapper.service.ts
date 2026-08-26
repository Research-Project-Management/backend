import { Injectable } from '@nestjs/common';
import {
  ReferenceManagerItemData,
  ReferenceManagerCreator,
  ReferenceManagerTag,
  CslItem,
  CslAuthor,
} from './types/cite.types';
import { UnifiedAcademicMetadata } from '../metadata/types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
} from '../metadata/utils/metadata.util';
import { extractFamilyName } from './utils/cite.util';

@Injectable()
export class MapperService {
  /**
   * Reference itemType to CSL type mapping dictionary
   */
  private static readonly REF_TO_CSL_TYPE: Record<string, string> = {
    journalArticle: 'article-journal',
    conferencePaper: 'paper-conference',
    book: 'book',
    bookSection: 'chapter',
    thesis: 'thesis',
    report: 'report',
    preprint: 'article',
    webpage: 'webpage',
    manuscript: 'manuscript',
    patent: 'patent',
    document: 'document',
    magazineArticle: 'article-magazine',
    newspaperArticle: 'article-newspaper',
    encyclopediaArticle: 'entry-encyclopedia',
    dictionaryEntry: 'entry-dictionary',
  };

  /**
   * CSL type to Reference itemType mapping dictionary
   */
  private static readonly CSL_TO_REF_TYPE: Record<string, string> = {
    'article-journal': 'journalArticle',
    'paper-conference': 'conferencePaper',
    book: 'book',
    chapter: 'bookSection',
    thesis: 'thesis',
    report: 'report',
    article: 'preprint',
    webpage: 'webpage',
    manuscript: 'manuscript',
    patent: 'patent',
    document: 'document',
    'article-magazine': 'magazineArticle',
    'article-newspaper': 'newspaperArticle',
    'entry-encyclopedia': 'encyclopediaArticle',
    'entry-dictionary': 'dictionaryEntry',
  };

  /**
   * Transforms unified metadata or catalog item into standard Reference Manager format
   */
  toReferenceItem(
    item: Partial<UnifiedAcademicMetadata> & Record<string, any>,
  ): ReferenceManagerItemData {
    const creators: ReferenceManagerCreator[] = [];

    if (Array.isArray(item.creators) && item.creators.length > 0) {
      for (const c of item.creators) {
        if (c.name) {
          creators.push({
            creatorType: c.creatorType || 'author',
            name: c.name,
          });
        } else {
          creators.push({
            creatorType: c.creatorType || 'author',
            firstName: c.firstName || '',
            lastName: c.lastName || c.name || '',
          });
        }
      }
    } else {
      if (Array.isArray(item.authors)) {
        for (const author of item.authors) {
          if (!author?.trim()) continue;
          const parsed = this.parseAuthorName(author);
          creators.push({
            creatorType: 'author',
            ...parsed,
          });
        }
      }
      if (Array.isArray(item.editors)) {
        for (const editor of item.editors) {
          if (!editor?.trim()) continue;
          const parsed = this.parseAuthorName(editor);
          creators.push({
            creatorType: 'editor',
            ...parsed,
          });
        }
      }
    }

    const tags: ReferenceManagerTag[] = [];
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        if (typeof tag === 'string') {
          tags.push({ tag, type: 0 });
        } else if (tag && typeof tag === 'object') {
          tags.push({
            tag: (tag as any).name || (tag as any).tag || '',
            type: 0,
          });
        }
      }
    }
    if (Array.isArray(item.labels)) {
      for (const label of item.labels) {
        if (typeof label === 'string' && !tags.some((t) => t.tag === label)) {
          tags.push({ tag: label, type: 0 });
        }
      }
    }
    if (Array.isArray(item.keywords)) {
      for (const kw of item.keywords) {
        if (typeof kw === 'string' && !tags.some((t) => t.tag === kw)) {
          tags.push({ tag: kw, type: 0 });
        }
      }
    }

    // Build extra field with custom key-value pairs (e.g. arXiv ID, PMCID, S2ID)
    const extraLines: string[] = [];
    if (item.extra && typeof item.extra === 'string') {
      extraLines.push(item.extra);
    }
    if (item.arxivId) {
      extraLines.push(`arXiv: ${item.arxivId}`);
    }
    if (item.pmcid) {
      extraLines.push(`PMCID: ${item.pmcid}`);
    }
    if (item.pmid && !extraLines.some((l) => l.includes('PMID:'))) {
      extraLines.push(`PMID: ${item.pmid}`);
    }
    if (
      item.citationKey &&
      !extraLines.some((l) => l.includes('Citation Key:'))
    ) {
      extraLines.push(`Citation Key: ${item.citationKey}`);
    }

    const itemType = item.itemType || 'journalArticle';

    return {
      key: item.id || item.key,
      version: item.version,
      itemType,
      title: item.title || 'Untitled Document',
      creators,
      abstractNote: item.abstract || item.abstractNote || '',
      publicationTitle:
        item.publicationTitle || item.journal || item.publisher || '',
      journalAbbreviation: item.journalAbbreviation || '',
      volume: item.volume ? String(item.volume) : '',
      issue: item.issue ? String(item.issue) : '',
      pages: item.pages ? String(item.pages) : '',
      date: item.publicationDate || (item.year ? String(item.year) : ''),
      series: item.series || '',
      seriesTitle: item.seriesTitle || '',
      seriesText: item.seriesText || '',
      publisher: item.publisher || '',
      place: item.place || '',
      language: item.language || 'en',
      ISBN: normalizeIsbn(item.isbn) || item.isbn || '',
      ISSN: normalizeIssn(item.issn) || item.issn || '',
      DOI: normalizeDoi(item.doi) || item.doi || '',
      url: item.url || '',
      accessDate: item.accessedAt
        ? new Date(item.accessedAt).toISOString()
        : '',
      archive: item.archive || '',
      archiveLocation: item.archiveLocation || '',
      callNumber: item.callNumber || '',
      rights: item.rights || item.license || '',
      extra: extraLines.join('\n'),
      tags,
      collections:
        item.collections || (item.collectionId ? [item.collectionId] : []),
      dateAdded: item.createdAt ? new Date(item.createdAt).toISOString() : '',
      dateModified: item.updatedAt
        ? new Date(item.updatedAt).toISOString()
        : '',
    };
  }

  /**
   * Transforms Reference Manager item into UnifiedAcademicMetadata
   */
  fromReferenceItem(
    refItem: ReferenceManagerItemData,
  ): UnifiedAcademicMetadata & { authors: string[]; editors: string[] } {
    const authors: string[] = [];
    const editors: string[] = [];
    const creators = refItem.creators || [];

    for (const c of creators) {
      const name =
        c.name ||
        (c.lastName && c.firstName
          ? `${c.lastName}, ${c.firstName}`
          : c.lastName || c.firstName || '');
      if (!name) continue;

      if (c.creatorType === 'editor') {
        editors.push(name);
      } else {
        authors.push(name);
      }
    }

    const tags = (refItem.tags || []).map((t: any) => t.tag).filter(Boolean);

    let year: number | undefined;
    let arxivId: string | undefined;
    let pmid: string | undefined =
      typeof refItem.PMID === 'string' ? refItem.PMID : undefined;
    let pmcid: string | undefined;
    let citationKey: string | undefined;

    if (refItem.date) {
      const match = refItem.date.match(/\b(19\d{2}|20\d{2})\b/);
      if (match) {
        year = parseInt(match[1], 10);
      }
    }

    if (refItem.extra) {
      const lines = refItem.extra.split('\n');
      for (const line of lines) {
        const arxivMatch = line.match(/^arXiv:\s*(.+)$/i);
        if (arxivMatch) arxivId = arxivMatch[1].trim();

        const pmidMatch = line.match(/^PMID:\s*(.+)$/i);
        if (pmidMatch) pmid = pmidMatch[1].trim();

        const pmcidMatch = line.match(/^PMCID:\s*(.+)$/i);
        if (pmcidMatch) pmcid = pmcidMatch[1].trim();

        const citeKeyMatch = line.match(/^Citation Key:\s*(.+)$/i);
        if (citeKeyMatch) citationKey = citeKeyMatch[1].trim();
      }
    }

    return {
      doi: normalizeDoi(refItem.DOI),
      isbn: normalizeIsbn(refItem.ISBN),
      issn: normalizeIssn(refItem.ISSN),
      pmid: normalizePmid(pmid),
      pmcid: normalizePmcid(pmcid),
      arxivId: normalizeArxivId(arxivId),
      url: refItem.url || undefined,
      title: refItem.title || 'Untitled Document',
      authors,
      editors,
      year: year ?? null,
      publicationDate: refItem.date || undefined,
      itemType: refItem.itemType || 'journalArticle',
      journal: refItem.publicationTitle || undefined,
      publicationTitle: refItem.publicationTitle || undefined,
      publisher: refItem.publisher || undefined,
      volume: refItem.volume || undefined,
      issue: refItem.issue || undefined,
      pages: refItem.pages || undefined,
      abstract: refItem.abstractNote || undefined,
      tags,
      keywords: tags,
      citationKey,
      rights: refItem.rights || undefined,
      extra: refItem.extra || undefined,
    };
  }

  /**
   * Transforms unified metadata or catalog item into standard CSL JSON format
   */
  toCslJson(
    item: Partial<UnifiedAcademicMetadata> & Record<string, any>,
  ): CslItem {
    const cslAuthors: CslAuthor[] = [];
    const cslEditors: CslAuthor[] = [];

    if (Array.isArray(item.creators) && item.creators.length > 0) {
      for (const c of item.creators) {
        const authorObj: CslAuthor = c.name
          ? { literal: c.name }
          : { family: c.lastName || '', given: c.firstName || '' };

        if (c.creatorType === 'editor') {
          cslEditors.push(authorObj);
        } else {
          cslAuthors.push(authorObj);
        }
      }
    } else {
      if (Array.isArray(item.authors)) {
        for (const a of item.authors) {
          const parsed = this.parseAuthorName(a);
          cslAuthors.push({ family: parsed.lastName, given: parsed.firstName });
        }
      }
      if (Array.isArray(item.editors)) {
        for (const e of item.editors) {
          const parsed = this.parseAuthorName(e);
          cslEditors.push({ family: parsed.lastName, given: parsed.firstName });
        }
      }
    }

    const cslType =
      ReferenceManagerMapperService.REF_TO_CSL_TYPE[
        item.itemType || 'journalArticle'
      ] || 'article-journal';

    let issued: CslItem['issued'];
    if (item.year) {
      issued = { 'date-parts': [[item.year]] };
    }

    return {
      id: item.citationKey || item.id || 'ref-item',
      type: cslType,
      title: item.title || 'Untitled',
      author: cslAuthors.length ? cslAuthors : undefined,
      editor: cslEditors.length ? cslEditors : undefined,
      issued,
      abstract: item.abstract || item.abstractNote,
      'container-title': item.publicationTitle || item.journal,
      publisher: item.publisher,
      'publisher-place': item.place,
      volume: item.volume,
      issue: item.issue,
      page: item.pages,
      DOI: item.doi,
      ISBN: item.isbn,
      ISSN: item.issn,
      PMID: item.pmid,
      PMCID: item.pmcid,
      URL: item.url,
      language: item.language,
      keyword: Array.isArray(item.tags) ? item.tags.join(', ') : undefined,
      note: item.extra,
    };
  }

  /**
   * Transforms CSL JSON into UnifiedAcademicMetadata
   */
  fromCslJson(
    csl: CslItem,
  ): UnifiedAcademicMetadata & { authors: string[]; editors: string[] } {
    const authors: string[] = [];
    const editors: string[] = [];

    if (Array.isArray(csl.author)) {
      for (const a of csl.author) {
        if (a.literal) {
          authors.push(a.literal);
        } else if (a.family) {
          authors.push(a.given ? `${a.family}, ${a.given}` : a.family);
        }
      }
    }

    if (Array.isArray(csl.editor)) {
      for (const e of csl.editor) {
        if (e.literal) {
          editors.push(e.literal);
        } else if (e.family) {
          editors.push(e.given ? `${e.family}, ${e.given}` : e.family);
        }
      }
    }

    let year: number | undefined;
    if (csl.issued?.['date-parts']?.[0]?.[0]) {
      const parsedYear = parseInt(String(csl.issued['date-parts'][0][0]), 10);
      if (!isNaN(parsedYear)) year = parsedYear;
    }

    const itemType =
      ReferenceManagerMapperService.CSL_TO_REF_TYPE[csl.type] ||
      'journalArticle';

    return {
      doi: normalizeDoi(csl.DOI),
      isbn: normalizeIsbn(csl.ISBN),
      issn: normalizeIssn(csl.ISSN),
      pmid: normalizePmid(csl.PMID),
      pmcid: normalizePmcid(csl.PMCID),
      url: csl.URL,
      title: csl.title || 'Untitled Document',
      authors,
      editors,
      year: year ?? null,
      itemType,
      journal: csl['container-title'],
      publicationTitle: csl['container-title'],
      publisher: csl.publisher,
      volume: csl.volume ? String(csl.volume) : undefined,
      issue: csl.issue ? String(csl.issue) : undefined,
      pages: csl.page,
      abstract: csl.abstract,
      tags: csl.keyword
        ? csl.keyword.split(',').map((k: string) => k.trim())
        : [],
      keywords: csl.keyword
        ? csl.keyword.split(',').map((k: string) => k.trim())
        : [],

      citationKey: csl.id || undefined,
      extra: csl.note,
    };
  }

  private parseAuthorName(name: string): {
    firstName?: string;
    lastName: string;
  } {
    if (!name) return { lastName: '' };
    if (name.includes(',')) {
      const parts = name.split(',').map((p) => p.trim());
      return { lastName: parts[0], firstName: parts.slice(1).join(' ') };
    }
    const family = extractFamilyName(name);
    const given = name.slice(0, name.lastIndexOf(family)).trim();
    return { lastName: family, firstName: given || undefined };
  }
}
export const ReferenceManagerMapperService = MapperService;
export type ReferenceManagerMapperService = MapperService;
