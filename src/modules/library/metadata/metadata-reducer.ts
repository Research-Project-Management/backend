import { randomUUID } from 'crypto';
import { IngestDocumentDto } from '../ingestion/dto/ingestion.dto';
import {
  extractFamilyName,
  extractMeaningfulTitleWord,
} from '../citation/citation.util';

export interface PaperDraft {
  // Identifiers
  doi: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  issn: string;
  isbn: string;
  url: string;

  // Core bibliographic
  title: string;
  shortTitle?: string;
  authors: string[];
  editors?: string[];
  year: number | null;
  publicationDate?: string;
  itemType: string;

  // Venue & Series
  journal: string;
  publicationTitle?: string;
  journalAbbr?: string;
  publisher: string;
  place?: string;
  volume: string;
  issue: string;
  section?: string;
  pages: string;
  series?: string;
  seriesTitle?: string;
  language?: string;

  // Content & AI
  abstract: string;
  labels: string[];
  notes: any[];

  // Rights & Archival
  rights?: string;
  license?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  libraryCatalog?: string;
  extra?: string;

  // File attachments
  fileUrl: string;
  filename: string;
  storageId?: string | null;
  explicitCitationKey?: string;
}

export class AcademicMetadataReducer {
  /**
   * Converts a filename into a clean title search query.
   *
   * Handles Zotero Better BibTeX filenames (AuthorYEARKeyword_slug_words.pdf):
   *   "Bao2024Deepfmcrispr_deepfm_crispr_prediction_..." → "deepfm crispr prediction"
   *
   * Non-Zotero filenames are normalised: hyphens/underscores → spaces, extension stripped.
   * If the stripped result is ≤ 3 characters, falls back to full base to avoid empty queries.
   */
  static cleanFilenameForTitleSearch(filename: string): string {
    const base = filename.replace(/\.[^/.]+$/, ''); // strip extension
    const stripped = base.replace(/^[A-Za-z\u00C0-\u024F]+\d{4}[A-Za-z]+_/, ''); // strip AuthorYEARKeyword_
    const clean = stripped
      .replace(/[_\-]+/g, ' ') // separators → spaces
      .replace(/\s+/g, ' ')
      .trim();
    return clean.length > 3 ? clean : base.replace(/[_\-]+/g, ' ').trim();
  }

  /**
   * Generates a Better BibTeX compatible citation key (e.g. vaswani2017attention)
   */
  static deriveCitationKey(
    title: string,
    authors: string[] = [],
    year?: number | null,
  ): string {
    const firstAuthor =
      authors && authors.length > 0 ? extractFamilyName(authors[0]) : 'author';
    const cleanYear = year ? String(year) : 'nodate';
    const cleanTitleWord = extractMeaningfulTitleWord(title);
    return `${firstAuthor}${cleanYear}${cleanTitleWord}`;
  }

  /**
   * Initializes a baseline PaperDraft from an IngestDocumentDto or partial input.
   */
  static fromDto(dto: Partial<IngestDocumentDto>): PaperDraft {
    const fileUrl = dto.fileUrl || '';
    const filename =
      dto.filename ||
      (fileUrl ? fileUrl.split('/').pop() || 'paper.pdf' : 'document.pdf');
    const storageId = dto.storageFileId || dto.primaryFile?.fileId || null;

    const title = dto.title?.trim() || '';
    const authors = dto.authors ? [...dto.authors] : [];
    const year = dto.year || null;

    let explicitCitationKey = dto.citationKey?.trim() || undefined;
    if (!explicitCitationKey && (title || authors.length)) {
      explicitCitationKey = this.deriveCitationKey(title, authors, year);
    }

    return {
      title,
      shortTitle: (dto as any).shortTitle || undefined,
      authors,
      editors: (dto as any).editors ? [...(dto as any).editors] : [],
      year,
      publicationDate: (dto as any).publicationDate || undefined,
      doi: dto.doi?.trim() || '',
      arxivId: (dto as any).arxivId || undefined,
      pmid: (dto as any).pmid || undefined,
      pmcid: (dto as any).pmcid || undefined,
      journal: dto.journal || (dto as any).publicationTitle || '',
      publicationTitle: (dto as any).publicationTitle || dto.journal || '',
      journalAbbr: (dto as any).journalAbbr || undefined,
      publisher: dto.publisher || '',
      place: (dto as any).place || undefined,
      volume: dto.volume || '',
      issue: dto.issue || '',
      section: (dto as any).section || undefined,
      pages: dto.pages || '',
      series: (dto as any).series || undefined,
      seriesTitle: (dto as any).seriesTitle || undefined,
      issn: dto.issn || '',
      isbn: dto.isbn || '',
      url: dto.url || '',
      language: (dto as any).language || undefined,
      abstract: dto.abstract || '',
      itemType: dto.itemType || 'journalArticle',
      labels: dto.tags ? [...dto.tags] : [],
      notes: dto.notes ? [...dto.notes] : [],
      rights: (dto as any).rights || undefined,
      license: (dto as any).license || undefined,
      archive: (dto as any).archive || undefined,
      archiveLocation: (dto as any).archiveLocation || undefined,
      callNumber: (dto as any).callNumber || undefined,
      libraryCatalog: (dto as any).libraryCatalog || undefined,
      extra: (dto as any).extra || undefined,
      fileUrl,
      filename,
      storageId,
      explicitCitationKey,
    };
  }

  /**
   * Pure metadata merger: fills empty fields in `current` from `incoming` metadata without mutating `current`.
   */
  static merge(
    current: PaperDraft,
    incoming?: Record<string, any> | null,
  ): PaperDraft {
    if (!incoming) return { ...current };

    const next: PaperDraft = {
      ...current,
      authors: [...current.authors],
      editors: current.editors ? [...current.editors] : [],
      labels: [...current.labels],
      notes: [...current.notes],
    };

    if (!next.title && incoming.title) next.title = incoming.title;
    if (!next.shortTitle && incoming.shortTitle)
      next.shortTitle = incoming.shortTitle;
    if (!next.authors.length && incoming.authors?.length) {
      next.authors = [...incoming.authors];
    }
    if (!next.editors?.length && incoming.editors?.length) {
      next.editors = [...incoming.editors];
    }
    if (!next.year && incoming.year) next.year = incoming.year;
    if (!next.publicationDate && incoming.publicationDate) {
      next.publicationDate = incoming.publicationDate;
    }
    if (!next.doi && incoming.doi) next.doi = incoming.doi;
    if (!next.arxivId && incoming.arxivId) next.arxivId = incoming.arxivId;
    if (!next.pmid && incoming.pmid) next.pmid = incoming.pmid;
    if (!next.pmcid && incoming.pmcid) next.pmcid = incoming.pmcid;

    if (!next.journal && (incoming.journal || incoming.publicationTitle)) {
      next.journal = incoming.journal || incoming.publicationTitle;
    }
    if (
      !next.publicationTitle &&
      (incoming.publicationTitle || incoming.journal)
    ) {
      next.publicationTitle = incoming.publicationTitle || incoming.journal;
    }
    if (!next.journalAbbr && incoming.journalAbbr) {
      next.journalAbbr = incoming.journalAbbr;
    }
    if (!next.publisher && incoming.publisher) {
      next.publisher = incoming.publisher;
    }
    if (!next.place && incoming.place) next.place = incoming.place;
    if (!next.volume && incoming.volume) next.volume = incoming.volume;
    if (!next.issue && incoming.issue) next.issue = incoming.issue;
    if (!next.section && incoming.section) next.section = incoming.section;
    if (!next.pages && incoming.pages) next.pages = incoming.pages;
    if (!next.series && incoming.series) next.series = incoming.series;
    if (!next.seriesTitle && incoming.seriesTitle)
      next.seriesTitle = incoming.seriesTitle;
    if (!next.issn && incoming.issn) next.issn = incoming.issn;
    if (!next.isbn && incoming.isbn) next.isbn = incoming.isbn;
    if (!next.url && incoming.url) next.url = incoming.url;
    if (!next.language && incoming.language) next.language = incoming.language;
    if (!next.abstract && incoming.abstract) next.abstract = incoming.abstract;

    if (!next.itemType || next.itemType === 'journalArticle') {
      if (incoming.itemType) next.itemType = incoming.itemType;
    }

    const incomingTags = [
      ...(Array.isArray(incoming.keywords) ? incoming.keywords : []),
      ...(Array.isArray(incoming.labels) ? incoming.labels : []),
      ...(Array.isArray(incoming.tags) ? incoming.tags : []),
      ...(Array.isArray(incoming.fieldsOfStudy) ? incoming.fieldsOfStudy : []),
    ].filter(Boolean);

    if (incomingTags.length > 0) {
      const mergedSet = new Set<string>();
      for (const tag of next.labels) {
        if (tag && typeof tag === 'string' && tag.trim())
          mergedSet.add(tag.trim());
      }
      for (const tag of incomingTags) {
        if (tag && typeof tag === 'string' && tag.trim())
          mergedSet.add(tag.trim());
      }
      next.labels = Array.from(mergedSet);
    }

    if (!next.rights && incoming.rights) next.rights = incoming.rights;
    if (!next.license && incoming.license) next.license = incoming.license;
    if (!next.archive && incoming.archive) next.archive = incoming.archive;
    if (!next.archiveLocation && incoming.archiveLocation)
      next.archiveLocation = incoming.archiveLocation;
    if (!next.callNumber && incoming.callNumber)
      next.callNumber = incoming.callNumber;
    if (!next.libraryCatalog && incoming.libraryCatalog)
      next.libraryCatalog = incoming.libraryCatalog;

    if (!next.extra && incoming.extra) {
      next.extra = incoming.extra;
    } else if (
      incoming.extra &&
      next.extra &&
      !next.extra.includes(incoming.extra)
    ) {
      next.extra = `${next.extra}\n${incoming.extra}`.trim();
    }

    if (!next.notes.length && incoming.tldr) {
      next.notes = [
        {
          id: randomUUID(),
          content: `💡 **TL;DR Summary**:\n${incoming.tldr}`,
          createdAt: new Date().toISOString(),
        },
      ];
    }

    if (!next.fileUrl && incoming.openAccessPdfUrl) {
      next.fileUrl = incoming.openAccessPdfUrl;
    }

    // Automatically derive citationKey if not explicitly specified
    if (!next.explicitCitationKey && (next.title || next.authors.length)) {
      next.explicitCitationKey = this.deriveCitationKey(
        next.title,
        next.authors,
        next.year,
      );
    }

    return next;
  }

  /**
   * Applies BibTeX specific rules (annote -> notes, citationKey).
   */
  static mergeBibtex(
    current: PaperDraft,
    entry?: Record<string, any>,
  ): PaperDraft {
    if (!entry) return { ...current };
    let draft = this.merge(current, entry);

    if (entry.citationKey?.trim()) {
      draft = { ...draft, explicitCitationKey: entry.citationKey.trim() };
    }

    if (!draft.notes.length && entry.annote) {
      draft = {
        ...draft,
        notes: [
          {
            id: randomUUID(),
            content: entry.annote,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    }

    return draft;
  }
}
