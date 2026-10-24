import {
  CslItemData,
  CslName,
  CslDate,
} from '@/modules/library/citation/types/csl-json.types';
import {
  CSL_TYPE_MAP,
  CSL_CREATOR_MAP,
  SCHEMA_V42_DATA,
  harmonizeZoteroFields,
  normalizeAcademicTags,
  VIETNAMESE_FAMILY_NAMES,
  VIETNAMESE_COMPOUND_SURNAMES,
  VIETNAMESE_MIDDLE_NAMES,
  isVietnameseName,
  parseCreatorString,
  isInstitutionName,
} from '@/modules/library/core';

export const ITEM_TYPE_TO_CSL_TYPE: Record<string, string> = CSL_TYPE_MAP;

import {
  ContributorLike,
  EXTRA_DIRECT_CSL_STRING_KEYS,
  EXTRA_FALLBACK_CSL_STRING_KEYS,
  CslNameMapper,
  CslExtraMapper,
} from './csl-name-extra.mapper';
export type { ContributorLike };
export {
  EXTRA_DIRECT_CSL_STRING_KEYS,
  EXTRA_FALLBACK_CSL_STRING_KEYS,
  CslNameMapper,
  CslExtraMapper,
};

export interface CslSourceItem {
  id?: string | null; itemType?: string | null; title?: string | null; shortTitle?: string | null;
  version?: number | string | null; updatedAt?: Date | string | null; citationKey?: string | null;
  abstract?: string | null; doi?: string | null; isbn?: string | null; issn?: string | null;
  url?: string | null; volume?: string | null; issue?: string | null; pages?: string | null;
  publisher?: string | null; publicationTitle?: string | null; publicationDate?: string | null;
  date?: string | null; accessedAt?: Date | string | null; accessDate?: Date | string | null;
  edition?: string | number | null; year?: number | string | null; journal?: string | null;
  bookTitle?: string | null; proceedingsTitle?: string | null; repository?: string | null;
  series?: string | null; seriesTitle?: string | null; conferenceName?: string | null;
  place?: string | null; partNumber?: string | null; pmid?: string | null; pmcid?: string | null;
  archive?: string | null; archiveLocation?: string | null; callNumber?: string | null;
  arxivId?: string | null; thesisType?: string | null; reportType?: string | null;
  versionNumber?: string | null; authors?: string[] | null;
  contributors?: ContributorLike[] | null; creators?: ContributorLike[] | null;
  tags?: unknown[] | string | null; keywords?: unknown[] | string | null;
  itemTags?: Array<{ tag?: { name?: string | null } | null; name?: string | null }> | null;
  extraFields?: Record<string, unknown> | null; metadata?: unknown; extra?: string | null;
}

const PRIMARY_CREATOR_ROLES: Set<string> = new Set(
  Object.values(SCHEMA_V42_DATA.itemTypes).map((t) =>
    (t as { primaryCreatorType: string }).primaryCreatorType.toLowerCase(),
  ),
);

export class CslJsonMapper {
  static getAuthorNames(item: {
    contributors?: ContributorLike[];
    creators?: ContributorLike[];
    authors?: string[];
  }): string[] {
    const formatName = (c: ContributorLike) => {
      if (c.fullName?.trim()) return c.fullName.trim();
      const combined = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      return combined || c.name || 'Anonymous';
    };

    const list =
      Array.isArray(item.contributors) && item.contributors.length > 0
        ? item.contributors
        : Array.isArray(item.creators) && item.creators.length > 0
          ? item.creators
          : null;

    if (list) {
      const pick = (pred: (c: ContributorLike) => boolean) =>
        list.filter(pred).map(formatName).filter(Boolean);

      const authors = pick(
        (c) => (c.creatorType || 'author').toLowerCase() === 'author',
      );
      if (authors.length > 0) return authors;

      const primary = pick((c) =>
        PRIMARY_CREATOR_ROLES.has((c.creatorType || '').toLowerCase()),
      );
      if (primary.length > 0) return primary;

      const editors = pick(
        (c) => (c.creatorType || '').toLowerCase() === 'editor',
      );
      if (editors.length > 0) return editors;

      return list.map(formatName).filter(Boolean);
    }

    if (Array.isArray(item.authors) && item.authors.length > 0) {
      return item.authors.map((a) => String(a).trim()).filter(Boolean);
    }
    return [];
  }

  static toCsl(item: CslSourceItem): CslItemData {
    const rawType = item.itemType || 'journalArticle';
    const cslType = ITEM_TYPE_TO_CSL_TYPE[rawType] || 'article';

    const metaObj =
      item.metadata &&
      typeof item.metadata === 'object' &&
      !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : undefined;
    const rawExtraObj = { ...(metaObj || {}), ...(item.extraFields || {}) };

    const harmonized = harmonizeZoteroFields(
      {
        ...rawExtraObj,
        ...(item as Record<string, unknown>),
        extraFields: rawExtraObj,
      },
      { itemType: rawType, syncExtraFields: true },
    );
    const effectiveExtra =
      harmonized.extraFields && typeof harmonized.extraFields === 'object'
        ? (harmonized.extraFields as Record<string, unknown>)
        : rawExtraObj;

    const harmonizedObj = harmonized as Record<string, unknown>;
    const getStr = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const val = harmonizedObj[k] ?? effectiveExtra[k];
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
      return undefined;
    };

    const getStrOrNum = (...keys: string[]): string | number | undefined => {
      for (const k of keys) {
        const val = harmonizedObj[k] ?? effectiveExtra[k];
        if (typeof val === 'number') return val;
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
      return undefined;
    };

    const csl: CslItemData = {
      id: item.citationKey || item.id || `item_${Date.now()}`,
      ...(item.citationKey ? { 'citation-key': item.citationKey } : {}),
      type: cslType,
      title: getStr('title', 'caseName', 'nameOfAct', 'subject') || 'Untitled',
      _itemType: rawType,
      _version:
        item.version !== undefined && item.version !== null
          ? String(item.version)
          : item.updatedAt
            ? String(new Date(item.updatedAt).getTime())
            : undefined,
      _itemId: item.id,
      _updatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : undefined,
    };

    const rawPubDate = getStr('publicationDate', 'date', 'issueDate', 'dateDecided', 'dateEnacted');
    if (rawPubDate) {
      csl.issued = this.parseCslDate(rawPubDate) || (item.year ? { 'date-parts': [[Number(item.year)]] } : undefined);
    } else if (item.year) {
      csl.issued = { 'date-parts': [[Number(item.year)]] };
    } else if (typeof effectiveExtra.date === 'string' || typeof effectiveExtra.date === 'number') {
      const parsedYear = parseInt(String(effectiveExtra.date), 10);
      if (!isNaN(parsedYear)) csl.issued = { 'date-parts': [[parsedYear]] };
    }

    const rawFilingDate = getStr('filingDate');
    if (rawFilingDate) {
      const parsedSubmitted = this.parseCslDate(rawFilingDate);
      if (parsedSubmitted) csl.submitted = parsedSubmitted;
    }

    const rawAccessDate = item.accessedAt || item.accessDate || effectiveExtra.accessedAt || effectiveExtra.accessDate;
    if (rawAccessDate instanceof Date || typeof rawAccessDate === 'string' || typeof rawAccessDate === 'number') {
      const isoStr = rawAccessDate instanceof Date ? rawAccessDate.toISOString() : String(rawAccessDate).trim();
      const parsedAccessed = this.parseCslDate(isoStr);
      if (parsedAccessed) csl.accessed = parsedAccessed;
    }

    const container = getStr(
      'publicationTitle', 'journal', 'bookTitle', 'proceedingsTitle', 'reporter', 'code',
      'websiteTitle', 'blogTitle', 'forumTitle', 'dictionaryTitle', 'encyclopediaTitle', 'repository',
    );
    if (container) csl['container-title'] = container;

    const journalAbbrVal = getStr('journalAbbr', 'journalAbbreviation');
    if (journalAbbrVal) {
      csl['container-title-short'] = journalAbbrVal;
      csl.journalAbbreviation = journalAbbrVal;
    }

    const shortTitleVal = getStr('shortTitle');
    if (shortTitleVal) {
      csl['title-short'] = shortTitleVal;
      csl.shortTitle = shortTitleVal;
    }

    const seriesTitle = getStr('series', 'seriesTitle');
    if (seriesTitle) csl['collection-title'] = seriesTitle;

    const eventTitle = getStr('conferenceName', 'meeting', 'meetingName');
    if (eventTitle) {
      csl['event-title'] = eventTitle;
      csl.event = eventTitle;
    }

    const publisher = getStr(
      'publisher', 'university', 'institution', 'company', 'organization', 'committee', 'repository',
    );
    if (publisher) csl.publisher = publisher;

    const authorityVal = getStr('authority', 'court', 'issuingAuthority', 'legislativeBody');
    if (authorityVal) csl.authority = authorityVal;

    const place = getStr('place', 'publisherPlace', 'eventPlace', 'country');
    if (place) csl['publisher-place'] = place;

    const countryVal = getStr('country');
    if (countryVal) csl.jurisdiction = countryVal;

    const numberLocator = getStrOrNum(
      'reportNumber', 'patentNumber', 'docketNumber', 'publicLawNumber',
      'billNumber', 'standardNumber', 'number', 'applicationNumber', 'partNumber',
    );
    if (numberLocator !== undefined) csl.number = String(numberLocator);

    const volVal = getStrOrNum('volume', 'reporterVolume', 'codeNumber');
    if (volVal !== undefined) csl.volume = volVal;
    const issueVal = getStrOrNum('issue');
    if (issueVal !== undefined) csl.issue = issueVal;
    const pageVal = getStr('pages', 'firstPage');
    if (pageVal) csl.page = pageVal;

    const editionVal =
      item.edition ??
      (typeof effectiveExtra.edition === 'string' ||
      typeof effectiveExtra.edition === 'number'
        ? effectiveExtra.edition
        : undefined);
    if (editionVal !== undefined && editionVal !== null) csl.edition = editionVal;

    const numPagesVal = getStrOrNum('numPages', 'numberOfPages');
    if (numPagesVal !== undefined) csl['number-of-pages'] = numPagesVal;

    const doiVal = getStr('doi', 'DOI');
    const isbnVal = getStr('isbn', 'ISBN');
    const issnVal = getStr('issn', 'ISSN');
    const pmidVal = getStr('pmid', 'PMID');
    const pmcidVal = getStr('pmcid', 'PMCID');
    const arxivVal = getStr('arxivId');

    if (doiVal) csl.DOI = doiVal;
    if (isbnVal) csl.ISBN = isbnVal;
    if (issnVal) csl.ISSN = issnVal;
    if (pmidVal) csl.PMID = pmidVal;
    if (pmcidVal) csl.PMCID = pmcidVal;
    if (arxivVal) csl._arxivId = arxivVal;
    if (item.url) csl.URL = item.url;
    if (item.abstract) csl.abstract = item.abstract;

    const archiveVal = getStr('archive');
    if (archiveVal) csl.archive = archiveVal;
    const archiveLoc = getStr('archiveLocation');
    if (archiveLoc) {
      csl['archive-location'] = archiveLoc;
      csl.archive_location = archiveLoc;
    }
    const callNum = getStr('callNumber', 'applicationNumber');
    if (callNum) csl['call-number'] = callNum;
    const langVal = getStr('language');
    if (langVal) csl.language = langVal;

    const metaKeywords =
      (item as Record<string, unknown>)?.metadata &&
      typeof (item as Record<string, unknown>).metadata === 'object'
        ? ((item as Record<string, unknown>).metadata as Record<string, unknown>).keywords
        : undefined;

    const rawKeywordsSources = [
      item.tags,
      item.keywords,
      Array.isArray(item.itemTags) && item.itemTags.length > 0
        ? item.itemTags.map((it) => it.tag?.name || it.name)
        : undefined,
      metaKeywords,
      effectiveExtra.keywords,
      effectiveExtra.tags,
    ];

    const kwInput: Array<string | { name?: string; tag?: string }> = [];
    for (const src of rawKeywordsSources) {
      if (Array.isArray(src)) {
        kwInput.push(...(src as Array<string | { name?: string; tag?: string }>));
      } else if (typeof src === 'string' && src.trim()) {
        kwInput.push(src);
      }
    };
    if (kwInput.length > 0) {
      const kwStrings = normalizeAcademicTags(kwInput);
      if (kwStrings.length > 0) {
        csl.keyword = kwStrings.join(', ');
        csl._keywords = kwStrings;
      }
    }

    const rawNotesSource =
      (item as Record<string, unknown>).notes ??
      (item as Record<string, unknown>).notesList ??
      effectiveExtra.notes ??
      effectiveExtra.annote;
    if (!csl.annote && rawNotesSource) {
      if (typeof rawNotesSource === 'string' && rawNotesSource.trim()) {
        csl.annote = rawNotesSource.trim();
      } else if (Array.isArray(rawNotesSource) && rawNotesSource.length > 0) {
        const noteBodies = rawNotesSource
          .map((n) => {
            if (typeof n === 'string') return n.trim();
            if (n && typeof n === 'object') {
              const obj = n as Record<string, unknown>;
              const candidate = obj.contentMd ?? obj.content ?? obj.note;
              return typeof candidate === 'string' ? candidate.trim() : '';
            }
            return '';
          })
          .filter(Boolean);
        if (noteBodies.length > 0) csl.annote = noteBodies.join('\n\n');
      }
    }

    const rawExtraStr = getStr('extra');
    if (rawExtraStr) {
      this.parseExtraCslVariables(rawExtraStr, csl);
    } else if (arxivVal) {
      csl.note = `arXiv: ${arxivVal}`;
    }

    if (!csl.genre) {
      if (rawType === 'preprint') csl.genre = 'Preprint';
      else if (rawType === 'thesis') csl.genre = getStr('thesisType', 'type');
      else if (rawType === 'report') csl.genre = getStr('reportType', 'type');
      else csl.genre = getStr('genre', 'type', 'websiteType');
    }

    const versionNumber =
      item.versionNumber || effectiveExtra.versionNumber || effectiveExtra.version;
    if (typeof versionNumber === 'string' || typeof versionNumber === 'number') {
      csl.version = String(versionNumber);
    }

    const rawContributors =
      Array.isArray(item.contributors) && item.contributors.length > 0
        ? item.contributors
        : Array.isArray(item.creators) && item.creators.length > 0
          ? item.creators
          : null;

    if (rawContributors && rawContributors.length > 0) {
      const typeDef = SCHEMA_V42_DATA.itemTypes[rawType];
      const primaryRoleForType = (
        typeDef?.primaryCreatorType || 'author'
      ).toLowerCase();

      const sortedContributors = [...rawContributors].sort(
        (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
      );

      for (const contributorItem of sortedContributors) {
        const rawRole = (contributorItem.creatorType || 'author').trim();
        const lowerRole = rawRole.toLowerCase();
        const cslName = this.formatCslName(contributorItem);
        const cslMappedRole =
          CSL_CREATOR_MAP[rawRole] || CSL_CREATOR_MAP[lowerRole];

        if (
          lowerRole === 'author' ||
          lowerRole === primaryRoleForType ||
          cslMappedRole === 'author'
        ) {
          if (!csl.author) csl.author = [];
          csl.author.push(cslName);
        } else if (cslMappedRole) {
          const roleRecord = csl as Record<string, unknown>;
          if (!Array.isArray(roleRecord[cslMappedRole])) {
            roleRecord[cslMappedRole] = [];
          }
          (roleRecord[cslMappedRole] as unknown[]).push(cslName);
        } else {
          if (!csl.contributor) csl.contributor = [];
          csl.contributor.push(cslName);
        }
      }
    } else if (Array.isArray(item.authors) && item.authors.length > 0) {
      csl.author = item.authors.map((authorName: string) =>
        this.parseStringName(authorName),
      );
    }

    const cslFieldMap = SCHEMA_V42_DATA.cslFieldMap;
    if (cslFieldMap) {
      const cslRecord = csl as Record<string, unknown>;
      for (const [zoteroField, cslField] of Object.entries(cslFieldMap)) {
        if (
          cslField === 'issued' ||
          cslField === 'accessed' ||
          cslField === 'submitted' ||
          cslField === 'original-date' ||
          cslRecord[cslField] !== undefined
        ) {
          continue;
        }
        const rawVal =
          (item as Record<string, unknown>)[zoteroField] ??
          effectiveExtra[zoteroField];
        if (
          (typeof rawVal === 'string' && rawVal.trim()) ||
          typeof rawVal === 'number'
        ) {
          cslRecord[cslField] = rawVal;
          if (
            cslField === 'shortTitle' &&
            cslRecord['title-short'] === undefined
          ) {
            cslRecord['title-short'] = rawVal;
          }
        }
      }
    }

    return csl;
  }

  private static formatCslName(contrib: ContributorLike): CslName {
    return CslNameMapper.formatCslName(contrib);
  }
  public static parseStringName(raw: string): CslName {
    return CslNameMapper.parseStringName(raw);
  }
  public static parseCslDate(dateStr: string): CslDate | undefined {
    return CslNameMapper.parseCslDate(dateStr);
  }
  public static parseExtraCslVariables(extraStr: string, csl: CslItemData): void {
    CslExtraMapper.parseExtraCslVariables(extraStr, csl);
  }
}
