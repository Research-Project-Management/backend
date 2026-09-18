import { CslItemData, CslName } from '../types/csl-json.types';
import {
  CSL_TYPE_MAP,
  CSL_CREATOR_MAP,
  SCHEMA_V42_DATA,
} from '../../types/constants/types.constants';

/**
 * Mapping of 37 Zotero / Flux item types to CSL v1.0.2 specification types.
 * Derived dynamically from official Zotero Schema v42 specifications (DRY).
 */
export const ITEM_TYPE_TO_CSL_TYPE: Record<string, string> = CSL_TYPE_MAP;

const PRIMARY_CREATOR_ROLES: Set<string> = new Set(
  Object.values(SCHEMA_V42_DATA.itemTypes).map((t) =>
    t.primaryCreatorType.toLowerCase(),
  ),
);

export class CslJsonMapper {
  /**
   * Derives a clean list of author display strings from item contributors or creators.
   * Handles all 40 Zotero item types by falling back to primary creator roles
   * (e.g. inventor, programmer, artist, presenter, etc.) when explicit authors are absent.
   */
  static getAuthorNames(item: {
    contributors?: any[];
    creators?: any[];
    authors?: string[];
  }): string[] {
    const formatName = (c: any) => {
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
      // 1. Explicit authors
      const authors = list
        .filter((c) => (c.creatorType || 'author').toLowerCase() === 'author')
        .map(formatName)
        .filter(Boolean);
      if (authors.length > 0) return authors;

      // 2. Primary creator types derived from Zotero Schema v42
      const primaryCreators = list
        .filter((c) =>
          PRIMARY_CREATOR_ROLES.has((c.creatorType || '').toLowerCase()),
        )
        .map(formatName)
        .filter(Boolean);
      if (primaryCreators.length > 0) return primaryCreators;

      // 3. Fallback to editors if available
      const editors = list
        .filter((c) => (c.creatorType || '').toLowerCase() === 'editor')
        .map(formatName)
        .filter(Boolean);
      if (editors.length > 0) return editors;

      // 4. Fallback to any non-empty creator
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
  static toCsl(item: any): CslItemData {
    const rawType = item.itemType || 'journalArticle';
    const cslType = ITEM_TYPE_TO_CSL_TYPE[rawType] || 'article';

    const csl: CslItemData = {
      id: item.citationKey || item.id || `item_${Date.now()}`,
      type: cslType,
      title: item.title || 'Untitled',
    };

    // Dates
    const rawPubDate =
      item.publicationDate ||
      item.extraFields?.publicationDate ||
      item.extraFields?.date;
    if (
      typeof rawPubDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}/.test(rawPubDate)
    ) {
      const parts = rawPubDate.slice(0, 10).split('-').map(Number);
      csl.issued = { 'date-parts': [[parts[0], parts[1], parts[2]]] };
    } else if (
      typeof rawPubDate === 'string' &&
      /^\d{4}-\d{2}/.test(rawPubDate)
    ) {
      const parts = rawPubDate.slice(0, 7).split('-').map(Number);
      csl.issued = { 'date-parts': [[parts[0], parts[1]]] };
    } else if (item.year) {
      csl.issued = { 'date-parts': [[Number(item.year)]] };
    } else if (item.extraFields?.date) {
      const parsedYear = parseInt(String(item.extraFields.date), 10);
      if (!isNaN(parsedYear)) {
        csl.issued = { 'date-parts': [[parsedYear]] };
      }
    }

    // Publication / Container
    const container =
      item.publicationTitle ||
      item.journal ||
      item.bookTitle ||
      item.proceedingsTitle ||
      item.repository ||
      item.extraFields?.bookTitle ||
      item.extraFields?.proceedingsTitle ||
      item.extraFields?.repository;
    if (container) {
      csl['container-title'] = container;
    }

    const seriesTitle =
      item.series ||
      item.seriesTitle ||
      item.extraFields?.series ||
      item.extraFields?.seriesTitle;
    if (seriesTitle) {
      csl['collection-title'] = seriesTitle;
    }

    const eventTitle =
      item.conferenceName ||
      item.extraFields?.conferenceName ||
      item.extraFields?.meeting;
    if (eventTitle) {
      csl['event-title'] = eventTitle;
    }

    const publisher =
      item.publisher ||
      item.repository ||
      item.extraFields?.publisher ||
      item.extraFields?.repository ||
      item.extraFields?.institution ||
      item.extraFields?.university;
    if (publisher) {
      csl.publisher = publisher;
    }

    const place =
      item.place ||
      item.extraFields?.place ||
      item.extraFields?.publisherPlace ||
      item.extraFields?.eventPlace;
    if (place) {
      csl['publisher-place'] = place;
    }

    const reportOrPatentNumber =
      item.extraFields?.reportNumber ||
      item.extraFields?.patentNumber ||
      item.extraFields?.applicationNumber ||
      item.partNumber;
    if (reportOrPatentNumber) {
      csl.number = String(reportOrPatentNumber);
    }

    // Locators
    if (item.volume || item.extraFields?.volume) {
      csl.volume = item.volume || item.extraFields?.volume;
    }
    if (item.issue || item.extraFields?.issue) {
      csl.issue = item.issue || item.extraFields?.issue;
    }
    if (item.pages || item.extraFields?.pages) {
      csl.page = item.pages || item.extraFields?.pages;
    }
    if (item.extraFields?.edition) {
      csl.edition = item.extraFields.edition;
    }
    if (item.extraFields?.numPages) {
      csl['number-of-pages'] = item.extraFields.numPages;
    }

    // Identifiers
    if (item.doi) csl.DOI = item.doi;
    if (item.isbn) csl.ISBN = item.isbn;
    if (item.issn) csl.ISSN = item.issn;
    if (item.pmid) csl.PMID = item.pmid;
    if (item.pmcid) csl.PMCID = item.pmcid;
    if (item.url) csl.URL = item.url;
    if (item.abstract) csl.abstract = item.abstract;
    if (item.archive) csl.archive = item.archive;
    if (item.archiveLocation) {
      csl['archive-location'] = item.archiveLocation;
      csl.archive_location = item.archiveLocation;
    }
    if (item.callNumber) csl['call-number'] = item.callNumber;
    if (item.language) csl.language = item.language;
    if (item.extra) csl.note = item.extra;

    // Special metadata
    if (rawType === 'preprint') {
      csl.genre = 'Preprint';
    } else if (rawType === 'thesis') {
      csl.genre = (item as any).thesisType || item.extraFields?.thesisType;
    } else if (rawType === 'report') {
      csl.genre = (item as any).reportType || item.extraFields?.reportType;
    }

    // Version
    const versionNumber =
      item.versionNumber ||
      item.extraFields?.versionNumber ||
      item.extraFields?.version;
    if (versionNumber) {
      csl.version = String(versionNumber);
    }

    // Contributors (Authors, Editors, Translators, etc.)
    const rawContributors =
      Array.isArray(item.contributors) && item.contributors.length > 0
        ? item.contributors
        : Array.isArray(item.creators) && item.creators.length > 0
          ? item.creators
          : null;

    if (rawContributors && rawContributors.length > 0) {
      const typeDef = SCHEMA_V42_DATA.itemTypes[rawType];
      const primaryRoleForType = (typeDef?.primaryCreatorType || 'author').toLowerCase();

      const sortedContributors = [...rawContributors].sort(
        (firstContributor, secondContributor) =>
          (firstContributor.orderIndex ?? 0) -
          (secondContributor.orderIndex ?? 0),
      );

      for (const contributorItem of sortedContributors) {
        const rawRole = (contributorItem.creatorType || 'author').trim();
        const lowerRole = rawRole.toLowerCase();
        const cslName = this.formatCslName(contributorItem);

        // Map through CSL_CREATOR_MAP derived dynamically from Zotero Schema v42
        const cslMappedRole =
          CSL_CREATOR_MAP[rawRole] ||
          CSL_CREATOR_MAP[lowerRole];

        if (
          lowerRole === 'author' ||
          lowerRole === primaryRoleForType ||
          cslMappedRole === 'author'
        ) {
          if (!csl.author) csl.author = [];
          csl.author.push(cslName);
        } else if (cslMappedRole) {
          if (!(csl as any)[cslMappedRole]) (csl as any)[cslMappedRole] = [];
          (csl as any)[cslMappedRole].push(cslName);
        } else {
          // Secondary unknown roles belong in contributor list
          if (!csl.contributor) csl.contributor = [];
          csl.contributor.push(cslName);
        }
      }
    } else if (Array.isArray(item.authors) && item.authors.length > 0) {
      // Fallback for raw string author arrays
      csl.author = item.authors.map((authorName: string) =>
        this.parseStringName(authorName),
      );
    }

    return csl;
  }

  /**
   * Formats a single contributor record into a CSL Name object.
   */
  private static formatCslName(contrib: any): CslName {
    if (contrib.lastName && contrib.lastName.trim()) {
      return {
        family: contrib.lastName.trim(),
        given: contrib.firstName ? contrib.firstName.trim() : undefined,
      };
    }

    if (contrib.fullName && contrib.fullName.trim()) {
      return this.parseStringName(contrib.fullName);
    }

    if (contrib.name && contrib.name.trim()) {
      return this.parseStringName(contrib.name);
    }

    if (contrib.firstName && contrib.firstName.trim()) {
      return this.parseStringName(contrib.firstName);
    }

    return { family: 'Anonymous' };
  }

  /**
   * Parses a single text name into CSL family/given format.
   * Recognizes institutional authors or "Last, First" vs "First Last".
   */
  public static parseStringName(raw: string): CslName {
    const trimmed = (raw || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) return { family: 'Anonymous' };

    // Check if institution (e.g. "Google DeepMind", "World Health Organization")
    const institutionalPattern =
      /(organization|consortium|association|institute|university|laboratory|committee|team|group|corporation|inc\.|llc|agency|openai|google|microsoft|meta)/i;
    if (institutionalPattern.test(trimmed) && !trimmed.includes(',')) {
      return { literal: trimmed };
    }

    // Comma-separated: "Preskill, John"
    if (trimmed.includes(',')) {
      const parts = trimmed.split(',').map((p) => p.trim());
      return {
        family: parts[0] || 'Anonymous',
        given: parts.slice(1).join(' ') || undefined,
      };
    }

    // Standard "First Last"
    const parts = trimmed.split(' ');
    if (parts.length === 1) {
      return { family: parts[0] };
    }

    const family = parts.pop() || 'Anonymous';
    const given = parts.join(' ');
    return { family, given };
  }
}
