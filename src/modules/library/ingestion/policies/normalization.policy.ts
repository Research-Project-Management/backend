import { Injectable } from '@nestjs/common';
import { ItemMetadata, CreatorInput } from '../metadata/types/metadata.types';

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
        result.doi = cleanDoi
          .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '')
          .replace(/^doi:\s*/i, '')
          .replace(/[.,;]+$/, '')
          .trim()
          .toLowerCase();
      }
    }

    // 4. Other Identifiers
    if (raw.arxivId) {
      const cleanArxiv = this.cleanString(raw.arxivId);
      if (cleanArxiv)
        result.arxivId = cleanArxiv.replace(/^arxiv:\s*/i, '').trim();
    }
    if (raw.pmid) {
      const cleanPmid = this.cleanString(raw.pmid);
      if (cleanPmid) result.pmid = cleanPmid.replace(/^pmid:\s*/i, '').trim();
    }
    if (raw.isbn) {
      const cleanIsbn = this.cleanString(raw.isbn);
      if (cleanIsbn) result.isbn = cleanIsbn.replace(/[- ]/g, '').trim();
    }
    if (raw.issn) {
      const cleanIssn = this.cleanString(raw.issn);
      if (cleanIssn) result.issn = cleanIssn.trim();
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

    // 6. Authors & Creators
    const creators = this.normalizeCreators(raw.creators, raw.authors);
    if (creators.length > 0) {
      result.creators = creators;
      result.authors = creators
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

    const pages = this.cleanString(raw.pages);
    if (pages) result.pages = pages.replace(/--/g, '-');

    // 8. Abstract
    const abstractText = this.cleanString(raw.abstract || raw.abstractNote);
    if (abstractText) result.abstract = abstractText;

    // 9. URL
    if (raw.url) {
      const cleanUrl = this.cleanString(raw.url);
      if (cleanUrl && /^https?:\/\//i.test(cleanUrl)) {
        result.url = cleanUrl;
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
      result.extraFields = raw.extraFields;
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

    // 14. File & Attachment references
    if (raw.fileId) result.fileId = this.cleanString(raw.fileId);
    if (raw.filename) result.filename = this.cleanString(raw.filename);
    if (raw.fileUrl) result.fileUrl = this.cleanString(raw.fileUrl);
    if (raw.pdfUrl) result.pdfUrl = this.cleanString(raw.pdfUrl);

    return result;
  }

  cleanString(val: unknown): string | undefined {
    if (val === undefined || val === null) return undefined;
    let str: string;
    if (typeof val === 'string') {
      str = val.trim();
    } else if (
      typeof val === 'number' ||
      typeof val === 'boolean' ||
      typeof val === 'bigint'
    ) {
      str = String(val).trim();
    } else {
      return undefined;
    }
    if (NormalizationPolicy.BANNED_STRINGS.has(str.toLowerCase())) {
      return undefined;
    }
    return str;
  }

  private stripLatexBraces(str: string): string {
    return str.replace(/[{}]/g, '').trim();
  }

  private normalizeCreators(
    creatorsInput?: CreatorInput[],
    authorsInput?: string[],
  ): CreatorInput[] {
    const list: CreatorInput[] = [];

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

        list.push({
          creatorType,
          name: effectiveName,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
        });
      }
    }

    if (list.length === 0 && Array.isArray(authorsInput)) {
      for (const a of authorsInput) {
        const cleanA = this.cleanString(a);
        if (!cleanA) continue;

        // Split "LastName, FirstName" if present
        const parts = cleanA.split(',');
        if (parts.length === 2) {
          const last = parts[0].trim();
          const first = parts[1].trim();
          list.push({
            creatorType: 'author',
            name: `${first} ${last}`,
            firstName: first,
            lastName: last,
          });
        } else {
          list.push({
            creatorType: 'author',
            name: cleanA,
          });
        }
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
