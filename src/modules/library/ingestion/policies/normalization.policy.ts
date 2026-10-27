import {
  ItemMetadata,
  CreatorInput,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  SCHEMA_V42_DATA,
  FIELD_ALIASES,
} from '@/modules/library/core/types/schema.constants';
import {
  cleanBibliographicText,
  cleanAbstractText,
  cleanBannedString,
  cleanCommentText,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  normalizeAcademicTitleCase,
  normalizeItemType,
  normalizePageRange,
  stripLatexBraces,
  convertAcademicHtmlToMarkdown,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import {
  resolveBidirectionalBaseFields,
  getEffectiveBaseFieldMap,
  extractExtraKeyValues,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';
import { normalizeCreators } from './creator-normalization.policy';

export { normalizeCreators };

const SPECIALLY_NORMALIZED_KEYS = new Set<string>([
  ...INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  'title', 'shortTitle', 'itemType', 'doi', 'DOI', 'arxivId', 'archiveID', 'archiveId',
  'pmid', 'PMID', 'pmcid', 'PMCID', 'isbn', 'ISBN', 'issn', 'ISSN', 'year',
  'publicationDate', 'date', 'accessedAt', 'accessDate', 'creators', 'authors',
  'editors', 'contributors', 'publicationTitle', 'publisher', 'volume', 'issue',
  'pages', 'abstract', 'abstractNote', 'url', 'URL', 'openAccessPdfUrl', 'tags',
  'keywords', 'labels', 'notes', 'extra', 'extraFields', 'citationCount',
  'referenceCount', 'numberOfPages', 'pageCount',
]);

const SCHEMA_DRIVEN_STRING_FIELDS: string[] = Array.from(
  new Set([
    ...SCHEMA_V42_DATA.distinctFieldKeys,
    ...Object.keys(FIELD_ALIASES),
    ...Object.values(FIELD_ALIASES),
    'journal',
    'journalAbbr',
    'type',
    'partNumber',
    'partTitle',
    'eventPlace',
    'priorityDate',
    'chapter',
    'license',
  ]),
).filter((key) => !SPECIALLY_NORMALIZED_KEYS.has(key));

/**
 * Untrusted provider/parser payload (BibTeX, RIS, CSL, Crossref, PDF, ...).
 * Shapes differ per source, so fields are probed defensively and every value
 * is validated by `cleanString` / dedicated normalizers before it reaches
 * `ItemMetadata`.
 */

type RawMetadataInput = Record<string, unknown>;

export class NormalizationPolicy {
  /**
   * Normalizes an entire ItemMetadata object deterministically.
   * Strips out empty placeholders, invalid dates, and formats creators.
   */
  normalize(raw: RawMetadataInput): ItemMetadata {
    const result: ItemMetadata = {};
    const rawRecord = raw;
    const rawExtra =
      raw.extraFields && typeof raw.extraFields === 'object'
        ? (raw.extraFields as Record<string, unknown>)
        : {};
    const getRawVal = (key: string): unknown => {
      if (rawRecord[key] !== undefined && rawRecord[key] !== null) {
        return rawRecord[key];
      }
      return rawExtra[key];
    };

    // 2. Item Type — normalise first so base field mappings can use it
    const rawItemType = getRawVal('itemType');
    if (rawItemType) {
      const cleaned = this.cleanString(rawItemType);
      if (cleaned) {
        const canonical = normalizeItemType(cleaned);
        result.itemType = canonical;
      }
    }

    const extraKv =
      typeof raw.extra === 'string' ? extractExtraKeyValues(raw.extra) : {};

    const baseMapForType = result.itemType
      ? getEffectiveBaseFieldMap(result.itemType)
      : {};

    // 1. Title (Only set if present in candidate or mapped base title field like caseName / nameOfAct / subject)
    const mappedTitleKey = baseMapForType.title;
    const rawTitleVal =
      raw.title ?? (mappedTitleKey ? getRawVal(mappedTitleKey) : undefined);
    if (rawTitleVal) {
      const cleanTitle = this.cleanString(rawTitleVal);
      if (cleanTitle) {
        const formattedTitle = normalizeAcademicTitleCase(
          stripLatexBraces(cleanTitle),
        );
        result.title = formattedTitle;
        if (mappedTitleKey) {
          (result as Record<string, unknown>)[mappedTitleKey] =
            this.cleanString(getRawVal(mappedTitleKey)) || formattedTitle;
        }
      }
    }

    if (raw.shortTitle ?? getRawVal('shortTitle')) {
      const cleanShort = this.cleanString(
        raw.shortTitle ?? getRawVal('shortTitle'),
      );
      if (cleanShort) {
        result.shortTitle = normalizeAcademicTitleCase(
          stripLatexBraces(cleanShort),
        );
      }
    }

    // 3. DOI
    const rawDoi = raw.doi ?? getRawVal('DOI') ?? getRawVal('doi') ?? extraKv.doi;
    if (rawDoi) {
      const cleanDoi = this.cleanString(rawDoi);
      if (cleanDoi) {
        result.doi = normalizeDoi(cleanDoi) || cleanDoi;
      }
    }

    // 4. Other Identifiers
    const rawArxiv =
      raw.arxivId ??
      getRawVal('archiveID') ??
      getRawVal('archiveId') ??
      getRawVal('arxivId') ??
      extraKv.arxiv ??
      extraKv.arxivid ??
      extraKv['arxiv-id'];
    if (rawArxiv) {
      const cleanArxiv = this.cleanString(rawArxiv);
      if (cleanArxiv) {
        const normArxiv = normalizeArxivId(cleanArxiv) || cleanArxiv;
        result.arxivId = normArxiv;
        if (getRawVal('archiveID') !== undefined) {
          (result as Record<string, unknown>).archiveID = cleanArxiv;
        }
      }
    }
    const rawPmid =
      raw.pmid ?? getRawVal('PMID') ?? getRawVal('pmid') ?? extraKv.pmid;
    if (rawPmid) {
      const cleanPmid = this.cleanString(rawPmid);
      if (cleanPmid) result.pmid = normalizePmid(cleanPmid) || cleanPmid;
    }
    const rawPmcid =
      raw.pmcid ??
      getRawVal('PMCID') ??
      getRawVal('pmcid') ??
      extraKv.pmcid ??
      extraKv.pmc;
    if (rawPmcid) {
      const cleanPmcid = this.cleanString(rawPmcid);
      if (cleanPmcid) result.pmcid = normalizePmcid(cleanPmcid) || cleanPmcid;
    }
    const rawIsbn =
      raw.isbn ?? getRawVal('ISBN') ?? getRawVal('isbn') ?? extraKv.isbn;
    if (rawIsbn) {
      const cleanIsbn = this.cleanString(rawIsbn);
      if (cleanIsbn) result.isbn = normalizeIsbn(cleanIsbn) || cleanIsbn;
    }
    const rawIssn =
      raw.issn ?? getRawVal('ISSN') ?? getRawVal('issn') ?? extraKv.issn;
    if (rawIssn) {
      const cleanIssn = this.cleanString(rawIssn);
      if (cleanIssn) result.issn = normalizeIssn(cleanIssn) || cleanIssn;
    }

    // 5. Year & Dates
    if (raw.year !== undefined && raw.year !== null) {
      const yearNum =
        typeof raw.year === 'number'
          ? raw.year
          : typeof raw.year === 'string'
            ? parseInt(raw.year, 10)
            : NaN;
      if (!isNaN(yearNum) && yearNum >= 1000 && yearNum <= 2100) {
        result.year = yearNum;
      }
    }

    const mappedDateKey = baseMapForType.date;
    const rawPubDate =
      raw.publicationDate ??
      raw.date ??
      (mappedDateKey ? getRawVal(mappedDateKey) : undefined) ??
      getRawVal('filingDate');
    if (rawPubDate) {
      const cleanDate = this.cleanString(rawPubDate);
      if (cleanDate) {
        if (raw.publicationDate || mappedDateKey) {
          result.publicationDate = cleanDate;
        }
        if (raw.date && !result.publicationDate) {
          result.date = cleanDate;
        } else if (raw.date) {
          result.date = this.cleanString(raw.date) || cleanDate;
        }
        if (mappedDateKey) {
          (result as Record<string, unknown>)[mappedDateKey] =
            this.cleanString(getRawVal(mappedDateKey)) || cleanDate;
        }
        if (!result.year) {
          const match = cleanDate.match(/\b(?:1\d{3}|20\d{2})\b/);
          if (match) result.year = parseInt(match[0], 10);
        }
      }
    }
    const rawAccessed = raw.accessedAt ?? getRawVal('accessDate');
    if (rawAccessed) {
      const parsed =
        rawAccessed instanceof Date
          ? rawAccessed
          : typeof rawAccessed === 'string' || typeof rawAccessed === 'number'
            ? new Date(rawAccessed)
            : new Date(NaN);
      if (!Number.isNaN(parsed.getTime())) result.accessedAt = parsed;
    }

    // 6. Authors & Creators
    const creators = this.normalizeCreators(
      Array.isArray(raw.creators)
        ? (raw.creators as CreatorInput[])
        : undefined,
      Array.isArray(raw.authors) ? (raw.authors as string[]) : undefined,
      Array.isArray(raw.editors) ? (raw.editors as string[]) : undefined,
      result.itemType,
    );
    if (creators.length > 0) {
      result.creators = creators;
      const authorCreators = creators.filter(
        (creator) => creator.creatorType === 'author',
      );
      result.authors = (authorCreators.length > 0 ? authorCreators : creators)
        .map((c) => c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim())
        .filter(Boolean);
    }

    // 7. Publication Details
    const mappedPubTitleKey = baseMapForType.publicationTitle;
    const pubTitle = this.cleanString(
      raw.publicationTitle ||
        raw.journal ||
        (mappedPubTitleKey ? getRawVal(mappedPubTitleKey) : undefined),
    );
    if (pubTitle) result.publicationTitle = pubTitle;

    const mappedPublisherKey = baseMapForType.publisher;
    const publisher = this.cleanString(
      raw.publisher ||
        (mappedPublisherKey ? getRawVal(mappedPublisherKey) : undefined),
    );
    if (publisher) result.publisher = publisher;

    const mappedPlaceKey = baseMapForType.place;
    const placeVal = this.cleanString(
      raw.place || (mappedPlaceKey ? getRawVal(mappedPlaceKey) : undefined),
    );
    if (placeVal) result.place = placeVal;

    const mappedVolumeKey = baseMapForType.volume;
    const volume = this.cleanString(
      raw.volume || (mappedVolumeKey ? getRawVal(mappedVolumeKey) : undefined),
    );
    if (volume) result.volume = volume;

    const mappedIssueKey = baseMapForType.issue || baseMapForType.number;
    const issue = this.cleanString(
      raw.issue !== undefined && raw.issue !== null && raw.issue !== ''
        ? raw.issue
        : mappedIssueKey
          ? getRawVal(mappedIssueKey)
          : undefined,
    );
    if (issue) result.issue = issue;

    for (const field of SCHEMA_DRIVEN_STRING_FIELDS) {
      const value = this.cleanString(getRawVal(field));
      if (value) (result as Record<string, unknown>)[field] = value;
    }
    const jAbbr = this.cleanString(
      getRawVal('journalAbbr') ?? getRawVal('journalAbbreviation'),
    );
    if (jAbbr) {
      result.journalAbbr = jAbbr;
      (result as Record<string, unknown>).journalAbbreviation = jAbbr;
    }

    const pageNum = raw.numberOfPages ?? raw.numPages ?? raw.pageCount;
    if (pageNum != null) {
      const cleanNum =
        typeof pageNum === 'number'
          ? pageNum
          : typeof pageNum === 'string'
            ? parseInt(pageNum, 10)
            : NaN;
      if (!isNaN(cleanNum) && cleanNum > 0) {
        result.numberOfPages = cleanNum;
        result.numPages = String(cleanNum);
        result.extraFields = {
          ...(result.extraFields || {}),
          numberOfPages: cleanNum,
          numPages: cleanNum,
        };
      }
    }

    const mappedPagesKey = baseMapForType.pages;
    const pages = this.cleanString(
      raw.pages || (mappedPagesKey ? getRawVal(mappedPagesKey) : undefined),
    );
    if (pages) result.pages = normalizePageRange(pages) || pages;

    // 8. Abstract
    const rawAbsBoth = [
      typeof raw.abstract === 'string' ? raw.abstract : undefined,
      typeof raw.abstractNote === 'string' ? raw.abstractNote : undefined,
      typeof rawExtra.abstractNote === 'string'
        ? rawExtra.abstractNote
        : undefined,
      typeof rawExtra.abstract === 'string' ? rawExtra.abstract : undefined,
    ]
      .filter((s): s is string => Boolean(s))
      .sort((a, b) => b.length - a.length)[0];
    const abstractText =
      cleanAbstractText(rawAbsBoth) || this.cleanString(rawAbsBoth);
    if (abstractText) {
      result.abstract = abstractText;
      result.abstractNote = abstractText;
    }

    // 9. URL
    const rawUrl = raw.url ?? getRawVal('URL') ?? getRawVal('url');
    if (rawUrl) {
      const cleanUrl = this.cleanString(rawUrl);
      if (cleanUrl && /^https?:\/\//i.test(cleanUrl)) {
        result.url = cleanUrl;
      }
    }
    if (raw.openAccessPdfUrl) {
      const cleanPdfUrl = this.cleanString(raw.openAccessPdfUrl);
      if (cleanPdfUrl && /^https?:\/\//i.test(cleanPdfUrl)) {
        result.openAccessPdfUrl = cleanPdfUrl;
      }
    }

    // 10. Tags & Keywords (Zotero tags)
    const rawTagList: string[] = [];
    if (Array.isArray(raw.tags)) rawTagList.push(...(raw.tags as string[]));
    if (Array.isArray(raw.keywords))
      rawTagList.push(...(raw.keywords as string[]));
    if (Array.isArray(raw.labels)) rawTagList.push(...(raw.labels as string[]));

    if (rawTagList.length > 0) {
      const normalizedTags = normalizeAcademicTags(rawTagList);
      if (normalizedTags.length > 0) {
        result.tags = normalizedTags;
        result.keywords = normalizedTags;
        result.labels = normalizedTags;
      }
    }

    // 11. Notes & Comments (Zotero notes / annote)
    if (Array.isArray(raw.notes) && raw.notes.length > 0) {
      const cleanNotes: Array<{
        content: string;
        title?: string;
        source?: string;
        tags?: string[];
      }> = [];
      const seenNotes = new Set<string>();
      for (const n of raw.notes) {
        const noteObj =
          typeof n === 'object' && n !== null
            ? (n as Record<string, unknown>)
            : null;
        const rawContent =
          typeof n === 'string'
            ? n
            : (noteObj?.content ?? noteObj?.contentMd ?? noteObj?.note);
        if (typeof rawContent !== 'string' || !rawContent.trim()) continue;

        const trimmedRaw = rawContent.trim();
        const noteSource =
          typeof noteObj?.source === 'string'
            ? noteObj.source.toLowerCase()
            : '';
        const isCommentNote =
          trimmedRaw.toLowerCase().startsWith('comment:') ||
          noteSource === 'arxiv';

        let cleanContent: string | undefined;
        if (
          !isCommentNote &&
          (/<\/?[a-z][\s\S]*>/i.test(trimmedRaw) || trimmedRaw.includes('\n'))
        ) {
          // Preserve multi-paragraph / Markdown / HTML structure for Zotero notes
          const md = convertAcademicHtmlToMarkdown(trimmedRaw);
          cleanContent = cleanBannedString(md);
        } else {
          const clean = cleanCommentText(trimmedRaw);
          if (clean) {
            cleanContent = trimmedRaw.toLowerCase().startsWith('comment:')
              ? `Comment: ${clean}`
              : clean;
          }
        }

        if (!cleanContent) continue;
        const dedupeKey = cleanContent.toLowerCase();
        if (seenNotes.has(dedupeKey)) continue;
        seenNotes.add(dedupeKey);

        const noteItem: {
          content: string;
          title?: string;
          source?: string;
          tags?: string[];
        } = {
          content: cleanContent,
        };
        if (typeof noteObj?.title === 'string' && noteObj.title.trim()) {
          noteItem.title = noteObj.title.trim();
        }
        if (typeof noteObj?.source === 'string' && noteObj.source.trim()) {
          noteItem.source = noteObj.source.trim();
        }
        if (Array.isArray(noteObj?.tags) && noteObj.tags.length > 0) {
          noteItem.tags = normalizeAcademicTags(noteObj.tags as string[]);
        }
        cleanNotes.push(noteItem);
      }

      if (cleanNotes.length > 0) {
        result.notes = cleanNotes;
      }
    }

    // 12. Citation Key
    const citKey = this.cleanString(raw.citationKey || raw.explicitCitationKey);
    if (citKey) result.citationKey = citKey;

    // 13. Extra Zotero & Extended Metadata
    if (raw.language) {
      const cleanLang = this.cleanString(raw.language);
      if (cleanLang) result.language = cleanLang;
    }
    if (raw.rights) {
      const cleanRights = this.cleanString(raw.rights);
      if (cleanRights) result.rights = cleanRights;
    }
    if (raw.license) {
      const cleanLicense = this.cleanString(raw.license);
      if (cleanLicense) result.license = cleanLicense;
    }
    if (raw.extra) {
      const cleanExtra =
        typeof raw.extra === 'string' && raw.extra.includes('\n')
          ? raw.extra
              .split(/\r?\n/)
              .map((line) => this.cleanString(line))
              .filter(Boolean)
              .join('\n')
          : this.cleanString(raw.extra);
      if (cleanExtra) result.extra = cleanExtra;
    }
    if (raw.extraFields && typeof raw.extraFields === 'object') {
      result.extraFields = this.cleanExtraFields(
        raw.extraFields as Record<string, unknown>,
      );
    }
    if (Array.isArray(raw.seeAlso) && raw.seeAlso.length > 0) {
      result.seeAlso = raw.seeAlso
        .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean);
    }
    if (Array.isArray(raw.relations)) {
      result.relations = raw.relations as ItemMetadata['relations'];
    }
    if (raw.libraryCatalog) {
      const cleanCat = this.cleanString(raw.libraryCatalog);
      if (cleanCat) result.libraryCatalog = cleanCat;
    }
    if (raw.callNumber) {
      const cleanCall = this.cleanString(raw.callNumber);
      if (cleanCall) result.callNumber = cleanCall;
    }
    if (raw.archive) {
      const cleanArch = this.cleanString(raw.archive);
      if (cleanArch) result.archive = cleanArch;
    }

    if (Array.isArray(raw.editors)) {
      const editors = raw.editors
        .map((editor: unknown) => {
          if (editor && typeof editor === 'object') {
            const edObj = editor as {
              firstName?: unknown;
              lastName?: unknown;
              fullName?: unknown;
              name?: unknown;
            };
            return (
              this.cleanString(edObj.fullName) ||
              this.cleanString(edObj.name) ||
              [
                this.cleanString(edObj.firstName),
                this.cleanString(edObj.lastName),
              ]
                .filter(Boolean)
                .join(' ') ||
              undefined
            );
          }
          return this.cleanString(editor);
        })
        .filter((editor: string | undefined): editor is string =>
          Boolean(editor),
        );
      if (editors.length > 0) result.editors = editors;
    }

    for (const field of ['citationCount', 'referenceCount'] as const) {
      const value = raw[field];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        result[field] = value;
      }
    }

    // 14. File & Attachment references
    if (raw.fileId) result.fileId = this.cleanString(raw.fileId);
    if (raw.filename) result.filename = this.cleanString(raw.filename);
    if (raw.fileUrl) result.fileUrl = this.cleanString(raw.fileUrl);
    if (raw.pdfUrl) result.pdfUrl = this.cleanString(raw.pdfUrl);

    const canonicalFields = new Set<string>([
      ...INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
      'title', 'shortTitle', 'itemType', 'doi', 'arxivId', 'pmid', 'pmcid', 'isbn', 'issn',
      'year', 'publicationDate', 'date', 'accessedAt', 'creators', 'authors', 'editors',
      'publicationTitle', 'journal', 'publisher', 'volume', 'issue', 'pages', 'abstract',
      'abstractNote', 'url', 'openAccessPdfUrl', 'tags', 'keywords', 'labels', 'notes',
      'citationKey', 'language', 'rights', 'license', 'extra', 'extraFields', 'fileId',
      'filename', 'fileUrl', 'pdfUrl', 'type', 'place', 'section', 'partNumber', 'partTitle',
      'series', 'seriesTitle', 'seriesText', 'seriesNumber', 'edition', 'repository',
      'journalAbbr', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'citationCount', 'referenceCount',
    ]);
    const preservedFields = Object.fromEntries(
      Object.entries(raw).filter(
        ([key, value]) =>
          !canonicalFields.has(key) && value !== undefined && value !== null,
      ),
    );
    if (Object.keys(preservedFields).length > 0) {
      result.extraFields = {
        ...(result.extraFields || {}),
        ...this.cleanExtraFields(preservedFields),
      };
    }

    if (result.itemType) {
      resolveBidirectionalBaseFields(result, result.itemType, undefined, false);
    }

    return result;
  }

  cleanString(val: unknown): string | undefined {
    if (val === undefined || val === null) return undefined;
    let str: string;
    if (typeof val === 'string') {
      str = cleanBibliographicText(val) || '';
    } else if (
      typeof val === 'number' ||
      typeof val === 'boolean' ||
      typeof val === 'bigint'
    ) {
      str = String(val).trim();
    } else {
      return undefined;
    }
    return cleanBannedString(str);
  }

  private cleanExtraFields(
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};

    for (const [rawKey, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      if (Array.isArray(value) && value.length === 0) continue;

      if (rawKey === 'archiveID') {
        cleaned.archiveID = value;
        if (cleaned.archiveId === undefined) {
          cleaned.archiveId = value;
        }
        continue;
      }
      cleaned[rawKey] = value;
    }

    return cleaned;
  }

  private normalizeCreators(
    creatorsInput?: CreatorInput[],
    authorsInput?: string[],
    editorsInput?: string[],
    itemType?: string,
  ): CreatorInput[] {
    return normalizeCreators(
      creatorsInput,
      authorsInput,
      editorsInput,
      itemType,
    );
  }
}
