import { Injectable, Logger } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-bibtex');

export interface ParsedBibtexEntry {
  citationKey?: string;
  itemType: string;
  title: string;
  authors: string[];
  year: number | null;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  abstract?: string;
  series?: string;
  keywords?: string[];
  notes?: string[];
  language?: string;
  rights?: string;
  fileUrl?: string;
  extra?: string;
}

@Injectable()
export class BibtexParser {
  private readonly logger = new Logger(BibtexParser.name);

  /**
   * Parse a raw BibTeX string containing one or multiple entries using @citation-js engine.
   */
  parse(rawBibtex: string): ParsedBibtexEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string' || !rawBibtex.trim()) {
      return [];
    }

    try {
      const cite = new Cite(rawBibtex);
      const data = cite.data || [];

      return data.map((csl: any) => {
        // Authors formatting: preserve author strings "Given Family" or "Family, Given"
        const authors: string[] = (csl.author || [])
          .map((a: any) => {
            if (a.literal) return a.literal.trim();
            if (a.given && a.family) return `${a.given} ${a.family}`.trim();
            return (a.family || a.given || '').trim();
          })
          .filter(Boolean);

        const year =
          csl.issued?.['date-parts']?.[0]?.[0] != null
            ? Number(csl.issued['date-parts'][0][0])
            : null;

        const itemType = this.mapCslTypeToItemType(
          csl.type || 'article-journal',
        );

        // Tags / keywords extraction
        const rawKeywords = csl.keyword || csl.keywords || csl.subject;
        let keywords: string[] | undefined;
        if (Array.isArray(rawKeywords)) {
          keywords = rawKeywords
            .map((k: any) => String(k).trim())
            .filter(Boolean);
        } else if (typeof rawKeywords === 'string' && rawKeywords.trim()) {
          keywords = rawKeywords
            .split(/[,;\n]/)
            .map((k: string) => k.trim())
            .filter(Boolean);
        }

        // Notes / annotations / comments extraction
        const rawNotes =
          csl.note || csl.annote || csl.comment || csl['annote'] || csl['note'];
        let notes: string[] | undefined;
        if (Array.isArray(rawNotes)) {
          notes = rawNotes.map((n: any) => String(n).trim()).filter(Boolean);
        } else if (typeof rawNotes === 'string' && rawNotes.trim()) {
          notes = [rawNotes.trim()];
        }

        return {
          citationKey: csl['citation-key'] || csl.id || undefined,
          itemType,
          title: (csl.title || 'Untitled Reference').trim(),
          authors,
          year,
          journal: csl['container-title'] || undefined,
          publisher: csl.publisher || undefined,
          volume: csl.volume ? String(csl.volume) : undefined,
          issue: csl.issue ? String(csl.issue) : undefined,
          pages: csl.page ? String(csl.page) : undefined,
          doi: csl.DOI || undefined,
          isbn: csl.ISBN || undefined,
          issn: csl.ISSN || undefined,
          url: csl.URL || undefined,
          abstract: csl.abstract || undefined,
          series: csl['collection-title'] || undefined,
          keywords: keywords && keywords.length > 0 ? keywords : undefined,
          notes: notes && notes.length > 0 ? notes : undefined,
          language: csl.language ? String(csl.language).trim() : undefined,
          rights: csl.rights ? String(csl.rights).trim() : undefined,
        };
      });
    } catch (err: any) {
      this.logger.warn(
        `Citation.js BibTeX parser error: ${err?.message || err}. Attempting fallback parsing.`,
      );
      return this.fallbackParse(rawBibtex);
    }
  }

  private mapCslTypeToItemType(cslType: string): string {
    const map: Record<string, string> = {
      'article-journal': 'journalArticle',
      'paper-conference': 'conferencePaper',
      book: 'book',
      chapter: 'bookSection',
      thesis: 'thesis',
      report: 'report',
      webpage: 'webpage',
      patent: 'patent',
      dataset: 'dataset',
      software: 'computerProgram',
    };
    return map[cslType] || 'journalArticle';
  }

  /**
   * Resilient regex fallback for non-standard BibTeX dialects
   */
  private fallbackParse(rawBibtex: string): ParsedBibtexEntry[] {
    const entries: ParsedBibtexEntry[] = [];
    const entryRegex =
      /@([a-zA-Z]+)\s*\{\s*([^,\s]*)\s*,([\s\S]*?)(?=\n\s*@[a-zA-Z]+\s*\{|\s*$)/g;

    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(rawBibtex)) !== null) {
      const rawType = match[1].toLowerCase();
      if (
        rawType === 'comment' ||
        rawType === 'preamble' ||
        rawType === 'string'
      ) {
        continue;
      }

      const citationKey = match[2]?.trim() || '';
      const body = match[3] || '';

      const fields: Record<string, string> = {};
      const fieldRegex = /([a-zA-Z_-]+)\s*=\s*(?:\{([^}]*)\}|"([^"]*)"|(\d+))/g;
      let fieldMatch: RegExpExecArray | null;
      while ((fieldMatch = fieldRegex.exec(body)) !== null) {
        const key = fieldMatch[1].toLowerCase();
        const value = fieldMatch[2] ?? fieldMatch[3] ?? fieldMatch[4] ?? '';
        fields[key] = value.trim();
      }

      const authors = fields.author
        ? fields.author
            .split(/\s+and\s+/i)
            .map((a) => a.trim())
            .filter(Boolean)
        : [];

      // Extract keywords / tags
      const rawKeywords = fields.keywords || fields.keyword || fields.tags;
      const keywords = rawKeywords
        ? rawKeywords
            .split(/[,;\n]/)
            .map((k) => k.trim())
            .filter(Boolean)
        : undefined;

      // Extract notes / annote / comment
      const rawNote = fields.note || fields.annote || fields.comment;
      const notes = rawNote ? [rawNote.trim()] : undefined;

      // Extract file path from Zotero/Mendeley BibTeX :path/to/file.pdf:PDF format
      let fileUrl: string | undefined;
      const rawFile = fields.file || fields.pdf;
      if (rawFile) {
        const cleanFile = rawFile.replace(/^:([^:]+):.*$/, '$1').trim();
        if (cleanFile) fileUrl = cleanFile;
      }

      entries.push({
        citationKey: citationKey || undefined,
        itemType: this.mapCslTypeToItemType(rawType),
        title: fields.title || 'Untitled Reference',
        authors,
        year: fields.year ? parseInt(fields.year, 10) || null : null,
        journal: fields.journal || fields.booktitle,
        publisher: fields.publisher,
        volume: fields.volume,
        issue: fields.number || fields.issue,
        pages: fields.pages,
        doi: fields.doi,
        isbn: fields.isbn,
        issn: fields.issn,
        url: fields.url,
        abstract: fields.abstract,
        keywords,
        notes,
        language: fields.language || undefined,
        rights: fields.rights || fields.license || undefined,
        fileUrl,
      });
    }

    return entries;
  }
}
