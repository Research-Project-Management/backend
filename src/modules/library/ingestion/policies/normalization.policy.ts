import {
  ItemMetadata,
  CreatorInput,
  CreatorType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  SCHEMA_V42_DATA,
  FIELD_ALIASES,
} from '@/modules/library/shared-kernel/types/schema.constants';
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
  parseCreatorString,
  splitAuthorString,
  normalizeAcademicTitleCase,
  normalizeItemType,
  normalizePageRange,
  isInstitutionName,
  stripLatexBraces,
} from '@/modules/library/shared-kernel/domain/bibliographic.domain';
import { normalizeTags } from '@/modules/library/shared-kernel/domain/tag.domain';
import {
  resolveBidirectionalBaseFields,
  resolveCanonicalCreatorRole,
} from '@/modules/library/shared-kernel/domain/zotero-field-harmonizer.domain';

const SPECIALLY_NORMALIZED_KEYS = new Set([
  'title',
  'shortTitle',
  'itemType',
  'doi',
  'DOI',
  'arxivId',
  'archiveID',
  'archiveId',
  'pmid',
  'PMID',
  'pmcid',
  'PMCID',
  'isbn',
  'ISBN',
  'issn',
  'ISSN',
  'year',
  'publicationDate',
  'date',
  'accessedAt',
  'accessDate',
  'creators',
  'authors',
  'editors',
  'contributors',
  'publicationTitle',
  'publisher',
  'volume',
  'issue',
  'pages',
  'abstract',
  'abstractNote',
  'url',
  'URL',
  'openAccessPdfUrl',
  'tags',
  'keywords',
  'labels',
  'notes',
  'extra',
  'extraFields',
  'citationCount',
  'referenceCount',
  'numberOfPages',
  'pageCount',
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

export class NormalizationPolicy {
  private static readonly BANNED_STRINGS = new Set([
    'undefined',
    'null',
    'n/a',
    'na',
    'none',
    'unknown',
    '',
  ]);

  /**
   * Normalizes an entire ItemMetadata object deterministically.
   * Strips out empty placeholders, invalid dates, and formats creators.
   */
  normalize(raw: Partial<ItemMetadata>): ItemMetadata {
    const result: ItemMetadata = {};
    const rawRecord = raw as Record<string, unknown>;
    const rawExtra =
      raw.extraFields && typeof raw.extraFields === 'object'
        ? raw.extraFields
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

    const baseMapForType = result.itemType
      ? (SCHEMA_V42_DATA.baseFieldMappings?.[result.itemType] ?? {})
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
    const rawDoi = raw.doi ?? getRawVal('DOI') ?? getRawVal('doi');
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
      getRawVal('arxivId');
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
    const rawPmid = raw.pmid ?? getRawVal('PMID') ?? getRawVal('pmid');
    if (rawPmid) {
      const cleanPmid = this.cleanString(rawPmid);
      if (cleanPmid) result.pmid = normalizePmid(cleanPmid) || cleanPmid;
    }
    const rawPmcid = raw.pmcid ?? getRawVal('PMCID') ?? getRawVal('pmcid');
    if (rawPmcid) {
      const cleanPmcid = this.cleanString(rawPmcid);
      if (cleanPmcid) result.pmcid = normalizePmcid(cleanPmcid) || cleanPmcid;
    }
    const rawIsbn = raw.isbn ?? getRawVal('ISBN') ?? getRawVal('isbn');
    if (rawIsbn) {
      const cleanIsbn = this.cleanString(rawIsbn);
      if (cleanIsbn) result.isbn = normalizeIsbn(cleanIsbn) || cleanIsbn;
    }
    const rawIssn = raw.issn ?? getRawVal('ISSN') ?? getRawVal('issn');
    if (rawIssn) {
      const cleanIssn = this.cleanString(rawIssn);
      if (cleanIssn) result.issn = normalizeIssn(cleanIssn) || cleanIssn;
    }

    // 5. Year & Dates
    if (raw.year !== undefined && raw.year !== null) {
      const yearNum =
        typeof raw.year === 'number'
          ? raw.year
          : parseInt(String(raw.year), 10);
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
          : new Date(String(rawAccessed));
      if (!Number.isNaN(parsed.getTime())) result.accessedAt = parsed;
    }

    // 6. Authors & Creators
    const creators = this.normalizeCreators(
      raw.creators,
      raw.authors,
      raw.editors,
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

    const mappedVolumeKey = baseMapForType.volume;
    const volume = this.cleanString(
      raw.volume || (mappedVolumeKey ? getRawVal(mappedVolumeKey) : undefined),
    );
    if (volume) result.volume = volume;

    const mappedIssueKey = baseMapForType.issue || baseMapForType.number;
    const issue = this.cleanString(
      raw.issue || (mappedIssueKey ? getRawVal(mappedIssueKey) : undefined),
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
        typeof pageNum === 'number' ? pageNum : parseInt(String(pageNum), 10);
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
      raw.abstract,
      raw.abstractNote,
      typeof rawExtra.abstractNote === 'string'
        ? rawExtra.abstractNote
        : undefined,
      typeof rawExtra.abstract === 'string' ? rawExtra.abstract : undefined,
    ]
      .filter(Boolean)
      .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
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
    if (Array.isArray(raw.tags)) rawTagList.push(...raw.tags);
    if (Array.isArray(raw.keywords)) rawTagList.push(...raw.keywords);
    if (Array.isArray(raw.labels)) rawTagList.push(...raw.labels);

    if (rawTagList.length > 0) {
      const normalizedTags = normalizeTags(rawTagList);
      if (normalizedTags.length > 0) {
        result.tags = normalizedTags;
        result.keywords = normalizedTags;
        result.labels = normalizedTags;
      }
    }

    // 11. Notes & Comments (Zotero notes / annote)
    if (Array.isArray(raw.notes) && raw.notes.length > 0) {
      const cleanNotes: Array<{ content: string; source?: string }> = [];
      for (const n of raw.notes) {
        const rawContent =
          typeof n === 'string' ? n : (n as { content?: string })?.content;
        if (typeof rawContent !== 'string') continue;
        const clean = cleanCommentText(rawContent);
        if (!clean) continue;
        const noteItem: { content: string; source?: string } = {
          content: rawContent.trim().toLowerCase().startsWith('comment:')
            ? `Comment: ${clean}`
            : clean,
        };
        if (
          n &&
          typeof n === 'object' &&
          'source' in n &&
          (n as { source?: string }).source
        ) {
          noteItem.source = String((n as { source?: string }).source).trim();
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
      const cleanExtra = this.cleanString(raw.extra);
      if (cleanExtra) result.extra = cleanExtra;
    }
    if (raw.extraFields && typeof raw.extraFields === 'object') {
      result.extraFields = this.cleanExtraFields(raw.extraFields);
    }
    if (Array.isArray(raw.seeAlso) && raw.seeAlso.length > 0) {
      result.seeAlso = raw.seeAlso
        .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean);
    }
    if (raw.relations && typeof raw.relations === 'object') {
      result.relations = raw.relations;
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
        .map((editor: unknown) => this.cleanString(editor))
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

    const canonicalFields = new Set([
      'title',
      'shortTitle',
      'itemType',
      'doi',
      'arxivId',
      'pmid',
      'pmcid',
      'isbn',
      'issn',
      'year',
      'publicationDate',
      'date',
      'accessedAt',
      'creators',
      'authors',
      'editors',
      'publicationTitle',
      'journal',
      'publisher',
      'volume',
      'issue',
      'pages',
      'abstract',
      'abstractNote',
      'url',
      'openAccessPdfUrl',
      'tags',
      'keywords',
      'labels',
      'notes',
      'citationKey',
      'language',
      'rights',
      'license',
      'extra',
      'extraFields',
      'fileId',
      'filename',
      'fileUrl',
      'pdfUrl',
      'type',
      'place',
      'section',
      'partNumber',
      'partTitle',
      'series',
      'seriesTitle',
      'seriesText',
      'seriesNumber',
      'edition',
      'repository',
      'journalAbbr',
      'archive',
      'archiveLocation',
      'libraryCatalog',
      'callNumber',
      'citationCount',
      'referenceCount',
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
    const list: CreatorInput[] = [];

    const append = (creator: CreatorInput) => {
      const creatorType = resolveCanonicalCreatorRole(creator.creatorType, {
        itemType,
      });
      let firstName = (creator.firstName || '').trim();
      let lastName = (creator.lastName || '').trim();
      let fullName = (creator.fullName || creator.name || '').trim();
      let fieldMode: number | undefined = creator.fieldMode;
      const shortName = this.cleanString(creator.shortName);

      if (fieldMode === 1) {
        const single = this.cleanString(lastName || fullName || firstName);
        if (!single) return;
        list.push({
          creatorType,
          name: single,
          fullName: single,
          lastName: single,
          fieldMode: 1,
          ...(shortName ? { shortName } : {}),
        });
        return;
      }

      const looksLikeOrg =
        !firstName && !!fullName && isInstitutionName(fullName);

      if (
        fullName &&
        !looksLikeOrg &&
        !firstName &&
        !lastName &&
        (fullName.includes(';') || /\s+(?:and|&)\s+/i.test(fullName))
      ) {
        const parts = splitAuthorString(fullName);
        if (parts.length > 1) {
          for (const part of parts) {
            append({ creatorType, fullName: part });
          }
          return;
        }
      }

      if (fullName && (fullName.includes(',') || (!firstName && !lastName))) {
        const parsed = parseCreatorString(fullName, 0, creatorType);
        if (parsed.fieldMode === 1) {
          fieldMode = 1;
          firstName = '';
          lastName = parsed.lastName || fullName;
          fullName = parsed.fullName || fullName;
        } else {
          firstName = parsed.firstName || firstName;
          lastName = parsed.lastName || lastName;
          fullName = parsed.fullName || fullName;
        }
      } else if (!fullName && (firstName || lastName)) {
        fullName = `${firstName} ${lastName}`.trim();
      }

      const cleanFirst = this.cleanString(firstName) || '';
      const cleanLast = this.cleanString(lastName) || '';
      const cleanFull = this.cleanString(fullName) || '';

      if (!cleanFull && !cleanFirst && !cleanLast) return;

      const effectiveName = cleanFull || `${cleanFirst} ${cleanLast}`.trim();

      list.push({
        creatorType,
        name: effectiveName,
        fullName: effectiveName,
        firstName: fieldMode === 1 ? undefined : cleanFirst || undefined,
        lastName: cleanLast || (fieldMode === 1 ? effectiveName : undefined),
        fieldMode: fieldMode === 1 ? 1 : 0,
        ...(shortName ? { shortName } : {}),
      });
    };

    const hasStructuredCreators =
      Array.isArray(creatorsInput) && creatorsInput.length > 0;

    if (hasStructuredCreators) {
      for (const c of creatorsInput) {
        if (!c || typeof c !== 'object') continue;
        append(c);
      }
    }

    if (!hasStructuredCreators && Array.isArray(authorsInput)) {
      for (const a of authorsInput) {
        for (const author of splitAuthorString(a)) {
          const cleanA = this.cleanString(author);
          if (!cleanA) continue;
          const parsed = parseCreatorString(cleanA, 0, 'author');
          append({
            creatorType: 'author',
            name: parsed.fullName,
            fullName: parsed.fullName,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            fieldMode: parsed.fieldMode,
          });
        }
      }
    }

    const hasStructuredEditors =
      hasStructuredCreators &&
      creatorsInput.some((c) => c && c.creatorType === 'editor');

    if (!hasStructuredEditors && Array.isArray(editorsInput)) {
      for (const editor of editorsInput) {
        for (const singleEditor of splitAuthorString(editor)) {
          const cleanEditor = this.cleanString(singleEditor);
          if (!cleanEditor) continue;
          const parsed = parseCreatorString(cleanEditor, 0, 'editor');
          append({
            creatorType: 'editor',
            name: parsed.fullName,
            fullName: parsed.fullName,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            fieldMode: parsed.fieldMode,
          });
        }
      }
    }

    return list;
  }
}
