import {
  ItemMetadata,
  CreatorInput,
  CreatorType,
} from '../types/metadata.types';
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
} from '../../shared-kernel/utils/bibliographic.utils';
import { normalizeTags } from '../../shared-kernel/utils/tag.utils';

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

    // 1. Title (Only set if present in candidate)
    if (raw.title) {
      const cleanTitle = this.cleanString(raw.title);
      if (cleanTitle) {
        result.title = normalizeAcademicTitleCase(stripLatexBraces(cleanTitle));
      }
    }

    if (raw.shortTitle) {
      const cleanShort = this.cleanString(raw.shortTitle);
      if (cleanShort) {
        result.shortTitle = normalizeAcademicTitleCase(
          stripLatexBraces(cleanShort),
        );
      }
    }

    // 2. Item Type — normalise only when a value is present.
    if (raw.itemType) {
      const cleaned = this.cleanString(raw.itemType);
      if (cleaned) {
        const canonical = normalizeItemType(cleaned);
        result.itemType = canonical;
      }
    }

    // 3. DOI
    if (raw.doi) {
      const cleanDoi = this.cleanString(raw.doi);
      if (cleanDoi) {
        result.doi = normalizeDoi(cleanDoi) || cleanDoi;
      }
    }

    // 4. Other Identifiers
    if (raw.arxivId) {
      const cleanArxiv = this.cleanString(raw.arxivId);
      if (cleanArxiv)
        result.arxivId = normalizeArxivId(cleanArxiv) || cleanArxiv;
    }
    if (raw.pmid) {
      const cleanPmid = this.cleanString(raw.pmid);
      if (cleanPmid) result.pmid = normalizePmid(cleanPmid) || cleanPmid;
    }
    if (raw.pmcid) {
      const cleanPmcid = this.cleanString(raw.pmcid);
      if (cleanPmcid) result.pmcid = normalizePmcid(cleanPmcid) || cleanPmcid;
    }
    if (raw.isbn) {
      const cleanIsbn = this.cleanString(raw.isbn);
      if (cleanIsbn) result.isbn = normalizeIsbn(cleanIsbn) || cleanIsbn;
    }
    if (raw.issn) {
      const cleanIssn = this.cleanString(raw.issn);
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

    if (raw.publicationDate) {
      const cleanDate = this.cleanString(raw.publicationDate);
      if (cleanDate) {
        result.publicationDate = cleanDate;
        if (!result.year) {
          const match = cleanDate.match(/\b(?:1\d{3}|20\d{2})\b/);
          if (match) result.year = parseInt(match[0], 10);
        }
      }
    }
    if (raw.date && !result.publicationDate) {
      const cleanDate = this.cleanString(raw.date);
      if (cleanDate) result.date = cleanDate;
    }
    if (raw.accessedAt) {
      const parsed =
        raw.accessedAt instanceof Date
          ? raw.accessedAt
          : new Date(String(raw.accessedAt));
      if (!Number.isNaN(parsed.getTime())) result.accessedAt = parsed;
    }

    // 6. Authors & Creators
    const creators = this.normalizeCreators(
      raw.creators,
      raw.authors,
      raw.editors,
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
    const pubTitle = this.cleanString(raw.publicationTitle || raw.journal);
    if (pubTitle) result.publicationTitle = pubTitle;

    const publisher = this.cleanString(raw.publisher);
    if (publisher) result.publisher = publisher;

    const volume = this.cleanString(raw.volume);
    if (volume) result.volume = volume;

    const issue = this.cleanString(raw.issue);
    if (issue) result.issue = issue;

    const stringFields: (keyof ItemMetadata)[] = [
      'journal',
      'journalAbbr',
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
      'type',
      'archiveLocation',
    ];
    for (const field of stringFields) {
      const value = this.cleanString(raw[field]);
      if (value) (result as Record<string, unknown>)[String(field)] = value;
    }

    const pageNum = raw.numberOfPages ?? raw.numPages ?? raw.pageCount;
    if (pageNum != null) {
      const cleanNum =
        typeof pageNum === 'number' ? pageNum : parseInt(String(pageNum), 10);
      if (!isNaN(cleanNum) && cleanNum > 0) {
        result.extraFields = {
          ...(result.extraFields || {}),
          numberOfPages: cleanNum,
          numPages: cleanNum,
        };
      }
    }

    const pages = this.cleanString(raw.pages);
    if (pages) result.pages = normalizePageRange(pages) || pages;

    // 8. Abstract
    const rawAbsBoth = [raw.abstract, raw.abstractNote]
      .filter(Boolean)
      .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
    const abstractText =
      cleanAbstractText(rawAbsBoth) || this.cleanString(rawAbsBoth);
    if (abstractText) {
      result.abstract = abstractText;
      result.abstractNote = abstractText;
    }

    // 9. URL
    if (raw.url) {
      const cleanUrl = this.cleanString(raw.url);
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
        .map((s: any) => (typeof s === 'string' ? s.trim() : ''))
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
        .map((editor: any) => this.cleanString(editor))
        .filter((editor: any): editor is string => Boolean(editor));
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

      const key = rawKey === 'archiveID' ? 'archiveId' : rawKey;
      if (key === 'archiveId' && cleaned[key] !== undefined) continue;
      cleaned[key] = value;
    }

    return cleaned;
  }

  private normalizeCreators(
    creatorsInput?: CreatorInput[],
    authorsInput?: string[],
    editorsInput?: string[],
  ): CreatorInput[] {
    const list: CreatorInput[] = [];

    const append = (creator: CreatorInput) => {
      const creatorType = (creator.creatorType as CreatorType) || 'author';
      let firstName = (creator.firstName || '').trim();
      let lastName = (creator.lastName || '').trim();
      let fullName = (creator.fullName || creator.name || '').trim();
      let fieldMode: number | undefined = creator.fieldMode;

      if (fieldMode === 1) {
        const single = this.cleanString(lastName || fullName || firstName);
        if (!single) return;
        list.push({
          creatorType,
          name: single,
          fullName: single,
          lastName: single,
          fieldMode: 1,
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
      });
    };

    const hasStructuredCreators =
      Array.isArray(creatorsInput) && creatorsInput.length > 0;

    if (hasStructuredCreators) {
      for (const c of creatorsInput!) {
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
      creatorsInput!.some((c) => c && c.creatorType === 'editor');

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
