import {
  CslItemData,
  CslName,
  CslDate,
} from '../../domain/types/csl-json.types';
import {
  CSL_TYPE_MAP,
  CSL_CREATOR_MAP,
  SCHEMA_V42_DATA,
} from '../../../shared-kernel/types/schema.constants';

/**
 * Mapping of 37 Zotero / Flux item types to CSL v1.0.2 specification types.
 * Derived dynamically from official Zotero Schema v42 specifications (DRY).
 */
export const ITEM_TYPE_TO_CSL_TYPE: Record<string, string> = CSL_TYPE_MAP;

const PRIMARY_CREATOR_ROLES: Set<string> = new Set(
  Object.values(SCHEMA_V42_DATA.itemTypes).map((t: any) =>
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
    if (item.extra) {
      this.parseExtraCslVariables(item.extra, csl);
    } else if (item.arxivId) {
      csl.note = `arXiv: ${item.arxivId}`;
    }

    // Special metadata
    if (rawType === 'preprint') {
      csl.genre = 'Preprint';
    } else if (rawType === 'thesis') {
      csl.genre = item.thesisType || item.extraFields?.thesisType;
    } else if (rawType === 'report') {
      csl.genre = item.reportType || item.extraFields?.reportType;
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
      const primaryRoleForType = (
        typeDef?.primaryCreatorType || 'author'
      ).toLowerCase();

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
          CSL_CREATOR_MAP[rawRole] || CSL_CREATOR_MAP[lowerRole];

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
    // 1. Single-field institutional creator (fieldMode === 1)
    if (contrib.fieldMode === 1 || contrib.fieldMode === '1') {
      const name =
        contrib.fullName?.trim() ||
        contrib.name?.trim() ||
        contrib.lastName?.trim() ||
        'Anonymous';
      const cslName: CslName = { literal: name };
      if (contrib.shortName && contrib.shortName.trim()) {
        cslName.short = contrib.shortName.trim();
      }
      return cslName;
    }

    // 2. Two-field creator with lastName / firstName
    if (contrib.lastName && contrib.lastName.trim()) {
      const cslName: CslName = {
        family: contrib.lastName.trim(),
        given: contrib.firstName ? contrib.firstName.trim() : undefined,
      };
      if (contrib.shortName && contrib.shortName.trim()) {
        cslName.short = contrib.shortName.trim();
      }
      return cslName;
    }

    if (contrib.fullName && contrib.fullName.trim()) {
      const parsed = this.parseStringName(contrib.fullName);
      if (contrib.shortName && contrib.shortName.trim()) {
        parsed.short = contrib.shortName.trim();
      }
      return parsed;
    }

    if (contrib.name && contrib.name.trim()) {
      const parsed = this.parseStringName(contrib.name);
      if (contrib.shortName && contrib.shortName.trim()) {
        parsed.short = contrib.shortName.trim();
      }
      return parsed;
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

  /**
   * Parses ISO-like date string into CSL Date object.
   */
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
   * Parses CSL variables embedded in Zotero's Extra field.
   * Conforms strictly to Zotero's parsing specification:
   * 1. Scans line by line from the top.
   * 2. Extracts valid CSL variables into target CSL properties.
   * 3. Stops scanning after encountering 2 consecutive non-key-value lines (Zotero heuristic).
   * 4. Leaves remaining non-CSL lines (identifiers, notes) in csl.note.
   */
  public static parseExtraCslVariables(
    extraStr: string,
    csl: CslItemData,
  ): void {
    if (!extraStr || !extraStr.trim()) return;

    const lines = extraStr.split(/\r?\n/);
    const remainingNotes: string[] = [];
    let invalidConsecutiveLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
      if (match && invalidConsecutiveLines < 2) {
        const rawKey = match[1].toLowerCase().replace(/_/g, '-');
        const val = match[2].trim();

        if (rawKey === 'original-date' || rawKey === 'originaldate') {
          const parsed = this.parseCslDate(val);
          if (parsed) csl['original-date'] = parsed;
        } else if (rawKey === 'event-date' || rawKey === 'eventdate') {
          const parsed = this.parseCslDate(val);
          if (parsed) csl['event-date'] = parsed;
        } else if (rawKey === 'event-place' || rawKey === 'eventplace') {
          csl['event-place'] = val;
        } else if (rawKey === 'event-title' || rawKey === 'eventtitle') {
          csl['event-title'] = val;
        } else if (rawKey === 'original-title' || rawKey === 'originaltitle') {
          csl['original-title'] = val;
        } else if (
          rawKey === 'original-publisher' ||
          rawKey === 'originalpublisher'
        ) {
          csl['original-publisher'] = val;
        } else if (
          rawKey === 'original-publisher-place' ||
          rawKey === 'originalpublisherplace'
        ) {
          csl['original-publisher-place'] = val;
        } else if (rawKey === 'status') {
          csl.status = val;
        } else if (rawKey === 'article-number' || rawKey === 'articlenumber') {
          csl.number = val;
          csl['article-number'] = val;
        } else if (rawKey === 'medium') {
          csl.medium = val;
        } else if (rawKey === 'dimensions') {
          csl.dimensions = val;
        } else if (rawKey === 'jurisdiction') {
          csl.jurisdiction = val;
        } else if (rawKey === 'annote') {
          csl.annote = val;
        } else if (rawKey === 'scale') {
          csl.scale = val;
        } else if (rawKey === 'genre' && !csl.genre) {
          csl.genre = val;
        } else if (rawKey === 'type' && !csl.type) {
          csl.type = val;
        } else if (rawKey === 'chapter-number' || rawKey === 'chapternumber') {
          csl['chapter-number'] = val;
        } else if (
          rawKey === 'collection-title' ||
          rawKey === 'collectiontitle'
        ) {
          csl['collection-title'] = val;
        } else if (
          rawKey === 'collection-number' ||
          rawKey === 'collectionnumber'
        ) {
          csl['collection-number'] = val;
        } else if (rawKey === 'container-title-short') {
          csl['container-title-short'] = val;
        } else if (rawKey === 'title-short' && !csl['title-short']) {
          csl['title-short'] = val;
        } else if (rawKey === 'archive-place') {
          csl['archive-place'] = val;
        } else {
          remainingNotes.push(trimmed);
        }
      } else {
        invalidConsecutiveLines++;
        remainingNotes.push(trimmed);
      }
    }

    if (remainingNotes.length > 0) {
      csl.note = remainingNotes.join('\n');
    }
  }
}
