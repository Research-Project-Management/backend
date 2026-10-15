import {
  CslItemData,
  CslName,
  CslDate,
} from '@/modules/library/citation/types/csl-json.types';
import {
  CSL_TYPE_MAP,
  CSL_CREATOR_MAP,
  SCHEMA_V42_DATA,
  VIETNAMESE_FAMILY_NAMES,
  VIETNAMESE_COMPOUND_SURNAMES,
  VIETNAMESE_MIDDLE_NAMES,
  hasVietnameseDiacritics,
  parseCreatorString,
  isInstitutionName,
  harmonizeZoteroFields,
} from '@/modules/library/shared-kernel';

/**
 * Mapping of 37 Zotero / Flux item types to CSL v1.0.2 specification types.
 * Derived dynamically from official Zotero Schema v42 specifications (DRY).
 */
export const ITEM_TYPE_TO_CSL_TYPE: Record<string, string> = CSL_TYPE_MAP;

export interface ContributorLike {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  role?: string | null;
  creatorType?: string | null;
  orderIndex?: number | null;
  fieldMode?: number | string | null;
  shortName?: string | null;
}

export interface CslSourceItem {
  id?: string | null;
  itemType?: string | null;
  title?: string | null;
  version?: number | string | null;
  updatedAt?: Date | string | null;
  citationKey?: string | null;
  abstract?: string | null;
  doi?: string | null;
  isbn?: string | null;
  issn?: string | null;
  url?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  publicationTitle?: string | null;
  publicationDate?: string | null;
  date?: string | null;
  accessedAt?: Date | string | null;
  accessDate?: Date | string | null;
  edition?: string | number | null;
  year?: number | string | null;
  journal?: string | null;
  bookTitle?: string | null;
  proceedingsTitle?: string | null;
  repository?: string | null;
  series?: string | null;
  seriesTitle?: string | null;
  conferenceName?: string | null;
  place?: string | null;
  partNumber?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  archive?: string | null;
  archiveLocation?: string | null;
  callNumber?: string | null;
  arxivId?: string | null;
  thesisType?: string | null;
  reportType?: string | null;
  versionNumber?: string | null;
  authors?: string[] | null;
  contributors?: ContributorLike[] | null;
  creators?: ContributorLike[] | null;
  extraFields?: Record<string, unknown> | null;
  metadata?: unknown;
  extra?: string | null;
}

const PRIMARY_CREATOR_ROLES: Set<string> = new Set(
  Object.values(SCHEMA_V42_DATA.itemTypes).map((t) =>
    (t as { primaryCreatorType: string }).primaryCreatorType.toLowerCase(),
  ),
);

const EXTRA_DIRECT_CSL_STRING_KEYS: Record<string, keyof CslItemData> = {
  'original-title': 'original-title',
  originaltitle: 'original-title',
  'original-publisher': 'original-publisher',
  originalpublisher: 'original-publisher',
  'original-publisher-place': 'original-publisher-place',
  originalpublisherplace: 'original-publisher-place',
  status: 'status',
  medium: 'medium',
  dimensions: 'dimensions',
  jurisdiction: 'jurisdiction',
  annote: 'annote',
  scale: 'scale',
  genre: 'genre',
  'chapter-number': 'chapter-number',
  chapternumber: 'chapter-number',
  'collection-title': 'collection-title',
  collectiontitle: 'collection-title',
  'collection-number': 'collection-number',
  collectionnumber: 'collection-number',
  'container-title-short': 'container-title-short',
  containertitleshort: 'container-title-short',
  'journal-abbr': 'container-title-short',
  'archive-place': 'archive-place',
  archiveplace: 'archive-place',
  'event-title': 'event-title',
  eventtitle: 'event-title',
  event: 'event-title',
};

const EXTRA_FALLBACK_CSL_STRING_KEYS: Record<string, keyof CslItemData> = {
  publisher: 'publisher',
  'publisher-place': 'publisher-place',
  publisherplace: 'publisher-place',
  place: 'publisher-place',
  'container-title': 'container-title',
  containertitle: 'container-title',
  'title-short': 'title-short',
  'short-title': 'title-short',
  archive: 'archive',
  'call-number': 'call-number',
  callnumber: 'call-number',
  isbn: 'ISBN',
  issn: 'ISSN',
  url: 'URL',
  version: 'version',
};

export class CslJsonMapper {
  static getAuthorNames(item: {
    contributors?: ContributorLike[];
    creators?: ContributorLike[];
    authors?: string[];
  }): string[] {
    const formatName = (c: ContributorLike) => {
      if (c.fullName && c.fullName.trim()) return c.fullName.trim();
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
      const pickByPredicate = (pred: (c: ContributorLike) => boolean) =>
        list.filter(pred).map(formatName).filter(Boolean);

      const authors = pickByPredicate(
        (c) => (c.creatorType || 'author').toLowerCase() === 'author',
      );
      if (authors.length > 0) return authors;

      const primaryCreators = pickByPredicate((c) =>
        PRIMARY_CREATOR_ROLES.has((c.creatorType || '').toLowerCase()),
      );
      if (primaryCreators.length > 0) return primaryCreators;

      const editors = pickByPredicate(
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

  /**
   * Transforms a database Item and related entities into a standard CSL-JSON item.
   */
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

    // Use Single-Source-of-Truth Harmonizer to unify base & mapped fields
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
      _updatedAt: item.updatedAt
        ? new Date(item.updatedAt).getTime()
        : undefined,
    };

    // Dates
    const rawPubDate = getStr(
      'publicationDate',
      'date',
      'issueDate',
      'dateDecided',
      'dateEnacted',
    );
    if (rawPubDate) {
      const parsedIssued = this.parseCslDate(rawPubDate);
      if (parsedIssued) {
        csl.issued = parsedIssued;
      } else if (item.year) {
        csl.issued = { 'date-parts': [[Number(item.year)]] };
      }
    } else if (item.year) {
      csl.issued = { 'date-parts': [[Number(item.year)]] };
    } else if (effectiveExtra.date) {
      const parsedYear = parseInt(String(effectiveExtra.date), 10);
      if (!isNaN(parsedYear)) {
        csl.issued = { 'date-parts': [[parsedYear]] };
      }
    }

    const rawFilingDate = getStr('filingDate');
    if (rawFilingDate) {
      const parsedSubmitted = this.parseCslDate(rawFilingDate);
      if (parsedSubmitted) csl.submitted = parsedSubmitted;
    }

    const rawAccessDate =
      item.accessedAt ||
      item.accessDate ||
      effectiveExtra.accessedAt ||
      effectiveExtra.accessDate;
    if (rawAccessDate) {
      const isoStr =
        rawAccessDate instanceof Date
          ? rawAccessDate.toISOString()
          : String(rawAccessDate).trim();
      const parsedAccessed = this.parseCslDate(isoStr);
      if (parsedAccessed) csl.accessed = parsedAccessed;
    }

    // Publication / Container & Publisher
    const container = getStr(
      'publicationTitle',
      'journal',
      'bookTitle',
      'proceedingsTitle',
      'reporter',
      'code',
      'websiteTitle',
      'blogTitle',
      'forumTitle',
      'dictionaryTitle',
      'encyclopediaTitle',
      'repository',
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
      'publisher',
      'university',
      'institution',
      'company',
      'organization',
      'committee',
      'repository',
    );
    if (publisher) csl.publisher = publisher;

    const authorityVal = getStr(
      'authority',
      'court',
      'issuingAuthority',
      'legislativeBody',
    );
    if (authorityVal) csl.authority = authorityVal;

    const place = getStr('place', 'publisherPlace', 'eventPlace', 'country');
    if (place) csl['publisher-place'] = place;

    const countryVal = getStr('country');
    if (countryVal) csl.jurisdiction = countryVal;

    const numberLocator = getStrOrNum(
      'reportNumber',
      'patentNumber',
      'docketNumber',
      'publicLawNumber',
      'billNumber',
      'standardNumber',
      'number',
      'applicationNumber',
      'partNumber',
    );
    if (numberLocator !== undefined) csl.number = String(numberLocator);

    // Locators
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
    if (editionVal !== undefined && editionVal !== null) {
      csl.edition = editionVal;
    }

    const numPagesVal = getStrOrNum('numPages', 'numberOfPages');
    if (numPagesVal !== undefined) csl['number-of-pages'] = numPagesVal;

    // Identifiers
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

    const rawKeywords = effectiveExtra.keywords ?? effectiveExtra.tags;
    if (Array.isArray(rawKeywords) && rawKeywords.length > 0) {
      const kwStrings = rawKeywords
        .map((k) =>
          typeof k === 'string'
            ? k.trim()
            : k && typeof k === 'object' && 'name' in k
              ? String((k as { name: unknown }).name).trim()
              : '',
        )
        .filter(Boolean);
      if (kwStrings.length > 0) {
        csl.keyword = kwStrings.join(', ');
        csl._keywords = kwStrings;
      }
    } else if (typeof rawKeywords === 'string' && rawKeywords.trim()) {
      csl.keyword = rawKeywords.trim();
    }

    const rawExtraStr = getStr('extra');
    if (rawExtraStr) {
      this.parseExtraCslVariables(rawExtraStr, csl);
    } else if (arxivVal) {
      csl.note = `arXiv: ${arxivVal}`;
    }

    // Genre & Version
    if (!csl.genre) {
      if (rawType === 'preprint') {
        csl.genre = 'Preprint';
      } else if (rawType === 'thesis') {
        csl.genre = getStr('thesisType', 'type');
      } else if (rawType === 'report') {
        csl.genre = getStr('reportType', 'type');
      } else {
        csl.genre = getStr('genre', 'type', 'websiteType');
      }
    }

    const versionNumber =
      item.versionNumber ||
      effectiveExtra.versionNumber ||
      effectiveExtra.version;
    if (versionNumber) {
      csl.version = String(versionNumber);
    }

    // Contributors
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

    // Schema-driven CSL field mapping fallback from Zotero Schema v42
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
    const attachShort = (target: CslName): CslName => {
      if (contrib.shortName && contrib.shortName.trim()) {
        target.short = contrib.shortName.trim();
      }
      return target;
    };

    if (contrib.fieldMode === 1 || contrib.fieldMode === '1') {
      const name =
        contrib.fullName?.trim() ||
        contrib.name?.trim() ||
        contrib.lastName?.trim() ||
        'Anonymous';
      return attachShort({ literal: name });
    }

    if (contrib.lastName && contrib.lastName.trim()) {
      const stripDegrees = (s: string) =>
        s
          .replace(
            /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi,
            '',
          )
          .trim();
      const rawLast = stripDegrees(contrib.lastName.trim());
      const rawFirst = contrib.firstName
        ? stripDegrees(contrib.firstName.trim())
        : '';

      if (!rawFirst && rawLast.includes(' ')) {
        return attachShort(this.parseStringName(rawLast));
      }

      if (rawFirst && !rawFirst.includes(',')) {
        const firstParts = rawFirst.split(/\s+/);
        const lastParts = rawLast.split(/\s+/);
        if (
          firstParts.length >= 1 &&
          lastParts.length === 1 &&
          this.VIETNAMESE_SURNAMES.has(firstParts[0].toLowerCase()) &&
          !this.VIETNAMESE_SURNAMES.has(lastParts[0].toLowerCase())
        ) {
          return attachShort(this.parseStringName(`${rawFirst} ${rawLast}`));
        }
      }

      return attachShort({
        family: rawLast,
        given: rawFirst || undefined,
      });
    }

    const fallbackFull =
      contrib.fullName?.trim() ||
      contrib.name?.trim() ||
      contrib.firstName?.trim();
    if (fallbackFull) {
      return attachShort(this.parseStringName(fallbackFull));
    }

    return { family: 'Anonymous' };
  }

  private static readonly VIETNAMESE_SURNAMES = VIETNAMESE_FAMILY_NAMES;
  private static readonly VIETNAMESE_COMPOUND_SURNAMES =
    VIETNAMESE_COMPOUND_SURNAMES;

  private static readonly DISTINCT_VN_SURNAMES = new Set([
    'nguyen',
    'tran',
    'pham',
    'huynh',
    'hoang',
    'trinh',
    'luong',
    'phung',
    'vuong',
    'quach',
    'trieu',
    'nghiem',
    'khong',
    'doan',
    'dinh',
    'dang',
    'bui',
    'ngo',
    'duong',
    'ly',
    'truong',
    'vu',
    'vo',
  ]);

  private static isVietnameseName(parts: string[]): boolean {
    if (parts.length < 2) return false;
    const firstLower = parts[0].toLowerCase();
    if (!this.VIETNAMESE_SURNAMES.has(firstLower)) return false;
    if (hasVietnameseDiacritics(parts.join(' '))) return true;
    if (this.DISTINCT_VN_SURNAMES.has(firstLower)) return true;
    if (parts.length >= 3) return true;
    return (
      parts.length === 2 && VIETNAMESE_MIDDLE_NAMES.has(parts[1].toLowerCase())
    );
  }

  public static parseStringName(raw: string): CslName {
    const trimmed = (raw || '')
      .trim()
      .replace(
        /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi,
        '',
      )
      .trim()
      .replace(/\s+/g, ' ');
    if (!trimmed) return { family: 'Anonymous' };

    const institutionalPattern =
      /(organization|consortium|association|institute|university|laboratory|committee|team|group|corporation|inc\.|llc|agency|department|ministry|academy|bureau|council|center|centre|foundation|society|openai|google|microsoft|meta|deepmind|who|unesco|ieee|acm|đại học|học viện|viện|trung tâm|bộ giáo dục|bộ y tế|bộ khoa học|tổng cục|cục|sở|ngân hàng|ban quản lý|hội đồng|liên minh)/i;
    if (
      (isInstitutionName(trimmed) || institutionalPattern.test(trimmed)) &&
      !trimmed.includes(',')
    ) {
      return { literal: trimmed };
    }

    if (trimmed.includes(',')) {
      const parts = trimmed.split(',').map((p) => p.trim());
      return {
        family: parts[0] || 'Anonymous',
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    const parts = trimmed.split(' ');
    if (parts.length === 1) {
      return { family: parts[0] };
    }

    if (this.isVietnameseName(parts)) {
      if (parts.length >= 3) {
        const potentialCompound = `${parts[0]} ${parts[1]}`.toLowerCase();
        if (this.VIETNAMESE_COMPOUND_SURNAMES.has(potentialCompound)) {
          return {
            family: `${parts[0]} ${parts[1]}`,
            given: parts.slice(2).join(' ') || undefined,
          };
        }
      }
      return {
        family: parts[0],
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    if (
      parts.length >= 3 &&
      /^(?:jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1])
    ) {
      const suffix = parts.pop()!;
      const fam = parts.pop() || 'Anonymous';
      const giv = parts.join(' ');
      return { family: fam, given: giv ? `${giv} ${suffix}` : suffix };
    }

    const parsedCreator = parseCreatorString(trimmed, 0, 'author');
    if (parsedCreator.fieldMode === 1) {
      return { literal: parsedCreator.fullName || trimmed };
    }
    if (parsedCreator.lastName) {
      return {
        family: parsedCreator.lastName,
        given: parsedCreator.firstName || undefined,
      };
    }

    const family = parts.pop() || 'Anonymous';
    const given = parts.join(' ');
    return { family, given };
  }

  public static parseCslDate(dateStr: string): CslDate | undefined {
    if (!dateStr) return undefined;
    const match = dateStr.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
    if (match) {
      const parts: number[] = [Number(match[1])];
      if (match[2]) parts.push(Number(match[2]));
      if (match[3]) parts.push(Number(match[3]));
      return { 'date-parts': [parts] };
    }
    return undefined;
  }

  /**
   * Parses CSL variables and identifiers embedded in Zotero's Extra field
   * using declarative lookup tables.
   */
  public static parseExtraCslVariables(
    extraStr: string,
    csl: CslItemData,
  ): void {
    if (!extraStr || !extraStr.trim()) return;
    const cslRec = csl as Record<string, unknown>;

    const applyKeyValue = (
      rawKeyInput: string,
      rawValInput: string,
    ): boolean => {
      const val = rawValInput.trim();
      if (!val) return false;
      const rawKey = rawKeyInput
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');

      if (rawKey === 'original-date' || rawKey === 'originaldate') {
        const parsed = this.parseCslDate(val);
        if (parsed) csl['original-date'] = parsed;
        return true;
      }
      if (rawKey === 'event-date' || rawKey === 'eventdate') {
        const parsed = this.parseCslDate(val);
        if (parsed) csl['event-date'] = parsed;
        return true;
      }
      if (rawKey === 'issued' && !csl.issued) {
        const parsed = this.parseCslDate(val);
        if (parsed) csl.issued = parsed;
        return true;
      }
      if (rawKey === 'accessed' && !csl.accessed) {
        const parsed = this.parseCslDate(val);
        if (parsed) csl.accessed = parsed;
        return true;
      }
      if (rawKey === 'event-place' || rawKey === 'eventplace') {
        csl['event-place'] = val;
        if (!csl['publisher-place']) csl['publisher-place'] = val;
        return true;
      }
      if (
        rawKey === 'article-number' ||
        rawKey === 'articlenumber' ||
        rawKey === 'number'
      ) {
        if (!csl.number) csl.number = val;
        if (rawKey !== 'number') csl['article-number'] = val;
        return true;
      }
      if (rawKey === 'type' || rawKey === 'csl-type') {
        csl.type = ITEM_TYPE_TO_CSL_TYPE[val] || val;
        return true;
      }
      if (
        (rawKey === 'archive-location' || rawKey === 'archivelocation') &&
        !csl['archive-location']
      ) {
        csl['archive-location'] = val;
        csl.archive_location = val;
        return true;
      }
      if (rawKey === 'doi') {
        if (!csl.DOI) {
          csl.DOI = val
            .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
            .trim();
        }
        return true;
      }
      if (rawKey === 'pmid') {
        if (!csl.PMID) csl.PMID = val.replace(/^pmid:\s*/i, '').trim();
        return true;
      }
      if (rawKey === 'pmcid' || rawKey === 'pmc') {
        if (!csl.PMCID) {
          const cleanPmc = val.replace(/^(?:pmcid|pmc):\s*/i, '').trim();
          csl.PMCID = /^PMC/i.test(cleanPmc)
            ? cleanPmc.toUpperCase()
            : `PMC${cleanPmc}`;
        }
        return true;
      }
      if (
        rawKey === 'citation-key' ||
        rawKey === 'citationkey' ||
        rawKey === 'citekey' ||
        rawKey === 'cite-key' ||
        rawKey === 'bibtex' ||
        rawKey === 'tex.ids'
      ) {
        const cleanKey = val.split(/[,\s]+/)[0]?.trim();
        if (cleanKey && !csl['citation-key']) {
          csl.id = cleanKey;
          csl['citation-key'] = cleanKey;
        }
        return true;
      }

      const directTarget = EXTRA_DIRECT_CSL_STRING_KEYS[rawKey];
      if (directTarget) {
        cslRec[directTarget] = val;
        return true;
      }

      const fallbackTarget = EXTRA_FALLBACK_CSL_STRING_KEYS[rawKey];
      if (fallbackTarget) {
        if (!cslRec[fallbackTarget]) cslRec[fallbackTarget] = val;
        return true;
      }

      return false;
    };

    const strippedBraced = extraStr.replace(
      /\{:\s*([a-zA-Z_][a-zA-Z0-9_.\s-]*?)\s*:\s*([^}]+?)\s*\}/g,
      (fullMatch, k: string, v: string) =>
        applyKeyValue(k, v) ? '' : fullMatch,
    );

    const remainingNotes: string[] = [];
    for (const line of strippedBraced.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(
        /^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/,
      );
      if (!match || !applyKeyValue(match[1], match[2])) {
        remainingNotes.push(trimmed);
      }
    }

    if (remainingNotes.length > 0) {
      csl.note = remainingNotes.join('\n');
    }
  }
}
