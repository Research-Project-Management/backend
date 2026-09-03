import { CslItemData, CslName } from '../types/csl-json.types';

/**
 * Mapping of 37 Zotero / Flux item types to CSL v1.0.2 specification types.
 */
export const ITEM_TYPE_TO_CSL_TYPE: Record<string, string> = {
  journalArticle: 'article-journal',
  conferencePaper: 'paper-conference',
  book: 'book',
  bookSection: 'chapter',
  preprint: 'article',
  report: 'report',
  thesis: 'thesis',
  patent: 'patent',
  webpage: 'webpage',
  blogPost: 'post-weblog',
  forumPost: 'post',
  dataset: 'dataset',
  computerProgram: 'software',
  map: 'map',
  manuscript: 'manuscript',
  film: 'motion_picture',
  videoRecording: 'motion_picture',
  audioRecording: 'song',
  podcast: 'song',
  radioBroadcast: 'broadcast',
  tvBroadcast: 'broadcast',
  presentation: 'speech',
  dictionaryEntry: 'entry-dictionary',
  encyclopediaArticle: 'entry-encyclopedia',
  case: 'legal_case',
  hearing: 'hearing',
  statute: 'legislation',
  bill: 'bill',
  interview: 'interview',
  letter: 'personal_communication',
  email: 'personal_communication',
  instantMessage: 'personal_communication',
  magazineArticle: 'article-magazine',
  newspaperArticle: 'article-newspaper',
  standard: 'standard',
  artwork: 'graphic',
  document: 'document',
};

export class CslJsonMapper {
  /**
   * Transforms a database CatalogItem and related entities into a standard CSL-JSON item.
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
    if (item.year) {
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
      item.extraFields?.bookTitle ||
      item.extraFields?.proceedingsTitle;
    if (container) {
      csl['container-title'] = container;
    }

    if (item.publisher || item.extraFields?.publisher) {
      csl.publisher = item.publisher || item.extraFields?.publisher;
    }

    if (item.extraFields?.place || item.extraFields?.publisherPlace) {
      csl['publisher-place'] =
        item.extraFields.place || item.extraFields.publisherPlace;
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
    if (item.url) csl.URL = item.url;
    if (item.abstract) csl.abstract = item.abstract;

    // Special metadata
    if (rawType === 'preprint') {
      csl.genre = 'Preprint';
    } else if (rawType === 'thesis' && item.extraFields?.thesisType) {
      csl.genre = item.extraFields.thesisType;
    } else if (rawType === 'report' && item.extraFields?.reportType) {
      csl.genre = item.extraFields.reportType;
    }

    // Contributors (Authors, Editors, Translators, etc.)
    const contributors = item.contributors || [];
    if (contributors.length > 0) {
      const sorted = [...contributors].sort(
        (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
      );

      for (const contrib of sorted) {
        const role = (contrib.creatorType || 'author').toLowerCase();
        const cslName = this.formatCslName(contrib);

        if (role === 'author') {
          if (!csl.author) csl.author = [];
          csl.author.push(cslName);
        } else if (role === 'editor') {
          if (!csl.editor) csl.editor = [];
          csl.editor.push(cslName);
        } else if (role === 'translator') {
          if (!csl.translator) csl.translator = [];
          csl.translator.push(cslName);
        } else if (role === 'director') {
          if (!csl.director) csl.director = [];
          csl.director.push(cslName);
        } else {
          // Default fallback to author
          if (!csl.author) csl.author = [];
          csl.author.push(cslName);
        }
      }
    } else if (Array.isArray(item.authors) && item.authors.length > 0) {
      // Fallback for raw string author arrays
      csl.author = item.authors.map((a: string) => this.parseStringName(a));
    } else if (Array.isArray(item.creators) && item.creators.length > 0) {
      // Fallback for creator DTOs
      csl.author = item.creators.map((c: any) => this.formatCslName(c));
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
