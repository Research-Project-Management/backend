import { Injectable } from '@nestjs/common';
import { ItemMetadata, CreatorInput } from '../metadata/types/metadata.types';
import {
  cleanBibliographicText,
  cleanBannedString,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  normalizeTags as canonicalNormalizeTags,
} from '../metadata/utils/metadata.utils';
import { parseCreatorString } from '../../items/creator-parser.util';

@Injectable()
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
      if (cleanTitle) result.title = this.stripLatexBraces(cleanTitle);
    }

    if (raw.shortTitle) {
      const cleanShort = this.cleanString(raw.shortTitle);
      if (cleanShort) result.shortTitle = this.stripLatexBraces(cleanShort);
    }

    // 2. Item Type
    if (raw.itemType) {
      result.itemType = this.cleanString(raw.itemType) || 'journalArticle';
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
          const match = cleanDate.match(/\b(19|20)\d{2}\b/);
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
      'type',
      'archiveLocation',
      'storageId',
      'explicitCitationKey',
    ];
    for (const field of stringFields) {
      const value = this.cleanString(raw[field]);
      if (value) (result as Record<string, unknown>)[field] = value;
    }

    const pages = this.cleanString(raw.pages);
    if (pages) result.pages = pages.replace(/--/g, '-');

    // 8. Abstract
    const abstractText = this.cleanString(raw.abstract || raw.abstractNote);
    if (abstractText) result.abstract = abstractText;
    const abstractNote = this.cleanString(raw.abstractNote);
    if (abstractNote) result.abstractNote = abstractNote;
    const tldr = this.cleanString(raw.tldr);
    if (tldr) result.tldr = tldr;

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
      const normalizedTags = this.normalizeTags(rawTagList);
      if (normalizedTags.length > 0) {
        result.tags = normalizedTags;
        result.keywords = normalizedTags;
        result.labels = normalizedTags;
      }
    }

    // 11. Notes & Comments (Zotero notes / annote)
    if (Array.isArray(raw.notes) && raw.notes.length > 0) {
      const cleanNotes = raw.notes
        .map((n: any) => {
          if (typeof n === 'string') {
            const clean = n.trim();
            return clean ? { content: clean } : null;
          }
          if (n && typeof n === 'object' && n.content) {
            const clean = String(n.content).trim();
            return clean
              ? {
                  content: clean,
                  source: n.source ? String(n.source).trim() : undefined,
                }
              : null;
          }
          return null;
        })
        .filter((n): n is { content: string; source?: string } =>
          Boolean(n && n.content),
        );

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
        .map((editor) => this.cleanString(editor))
        .filter((editor): editor is string => Boolean(editor));
      if (editors.length > 0) result.editors = editors;
    }

    for (const field of [
      'citationCount',
      'referenceCount',
      'influentialCitationCount',
    ] as const) {
      const value = raw[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[field] = value;
      }
    }

    // 14. File & Attachment references
    if (raw.fileId) result.fileId = this.cleanString(raw.fileId);
    if (raw.filename) result.filename = this.cleanString(raw.filename);
    if (raw.fileUrl) result.fileUrl = this.cleanString(raw.fileUrl);
    if (raw.pdfUrl) result.pdfUrl = this.cleanString(raw.pdfUrl);

    // Keep provider/type-specific fields that are not part of the canonical
    // columns. This prevents a newer metadata provider from losing fields at
    // the normalization boundary before commit.
    const canonicalFields = new Set([
      'title', 'shortTitle', 'itemType', 'doi', 'arxivId', 'pmid', 'pmcid',
      'isbn', 'issn', 'year', 'publicationDate', 'date', 'accessedAt',
      'creators', 'authors', 'editors', 'publicationTitle', 'journal',
      'publisher', 'volume', 'issue', 'pages', 'abstract', 'abstractNote',
      'tldr', 'url', 'openAccessPdfUrl', 'tags', 'keywords', 'labels',
      'notes', 'citationKey', 'explicitCitationKey', 'language', 'rights',
      'license', 'extra', 'extraFields', 'fileId', 'filename', 'fileUrl',
      'pdfUrl', 'type', 'place', 'section', 'partNumber', 'partTitle',
      'series', 'seriesTitle', 'seriesText', 'seriesNumber', 'journalAbbr',
      'storageId', 'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
      'citationCount', 'referenceCount', 'influentialCitationCount',
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

  private cleanExtraFields(fields: Record<string, unknown>): Record<string, unknown> {
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

  private stripLatexBraces(str: string): string {
    return str.replace(/[{}]/g, '').trim();
  }

  private normalizeCreators(
    creatorsInput?: CreatorInput[],
    authorsInput?: string[],
    editorsInput?: string[],
  ): CreatorInput[] {
    const list: CreatorInput[] = [];
    const known = new Set<string>();

    const append = (creator: CreatorInput) => {
      const name = creator.name || creator.fullName || '';
      const key = `${creator.creatorType || 'author'}:${name.toLocaleLowerCase()}`;
      if (!name || known.has(key)) return;
      known.add(key);
      list.push(creator);
    };

    if (Array.isArray(creatorsInput) && creatorsInput.length > 0) {
      for (const c of creatorsInput) {
        if (!c || typeof c !== 'object') continue;
        const name = this.cleanString(c.name);
        const firstName = this.cleanString(c.firstName);
        const lastName = this.cleanString(c.lastName);
        const creatorType = this.cleanString(c.creatorType) || 'author';

        if (!name && !firstName && !lastName) continue;

        const effectiveName =
          name || `${firstName || ''} ${lastName || ''}`.trim();

        append({
          creatorType,
          name: effectiveName,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
        });
      }
    }

    if (Array.isArray(authorsInput)) {
      for (const a of authorsInput) {
        const cleanA = this.cleanString(a);
        if (!cleanA) continue;

        // Split "LastName, FirstName" if present
        const parts = cleanA.split(',');
        if (parts.length === 2) {
          const last = parts[0].trim();
          const first = parts[1].trim();
          append({
            creatorType: 'author',
            name: `${first} ${last}`,
            firstName: first,
            lastName: last,
          });
        } else {
          append({
            creatorType: 'author',
            name: cleanA,
          });
        }
      }
    }

    if (Array.isArray(editorsInput)) {
      for (const editor of editorsInput) {
        const cleanEditor = this.cleanString(editor);
        if (cleanEditor) append({ creatorType: 'editor', name: cleanEditor });
      }
    }

    return list;
  }

  private normalizeTags(tags: string[]): string[] {
    const set = new Set<string>();
    for (const t of tags) {
      const clean = this.cleanString(t);
      if (!clean) continue;
      const stripped = clean.replace(/^#+/, '').trim().toLowerCase();
      if (stripped && !NormalizationPolicy.BANNED_STRINGS.has(stripped)) {
        set.add(stripped);
      }
    }
    return Array.from(set);
  }
}
