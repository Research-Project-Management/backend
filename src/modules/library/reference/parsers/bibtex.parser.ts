import { Injectable } from '@nestjs/common';

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
}

@Injectable()
export class BibtexParser {
  /**
   * Parse a raw BibTeX string containing one or multiple entries
   */
  parse(rawBibtex: string): ParsedBibtexEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string') return [];

    const entries: ParsedBibtexEntry[] = [];
    const entryRegex =
      /@([a-zA-Z]+)\s*\{\s*([^,\s]*)\s*,([\s\S]*?)(?=\n\s*@[a-zA-Z]+\s*\{|\s*$)/g;

    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(rawBibtex)) !== null) {
      const rawType = match[1].toLowerCase();
      const citationKey = match[2]?.trim() || '';
      const body = match[3] || '';

      const fields = this.parseFields(body);
      const itemType = this.mapBibtexTypeToItemType(rawType);

      // Parse authors
      const authors: string[] = [];
      if (fields.author) {
        const rawAuthors = fields.author.split(/\s+and\s+/i);
        for (const auth of rawAuthors) {
          const cleanAuth = this.cleanValue(auth);
          if (cleanAuth) authors.push(cleanAuth);
        }
      }

      // Parse year
      let year: number | null = null;
      if (fields.year) {
        const num = parseInt(this.cleanValue(fields.year).replace(/\D/g, ''), 10);
        if (!isNaN(num)) year = num;
      }

      const pages = fields.pages ? this.cleanValue(fields.pages).replace(/--/g, '-') : undefined;

      const title = this.cleanValue(fields.title || 'Untitled');
      const journal = this.cleanValue(fields.journal || fields.booktitle || '');
      const publisher = this.cleanValue(fields.publisher || fields.institution || fields.school || '');
      const volume = this.cleanValue(fields.volume || '');
      const issue = this.cleanValue(fields.number || fields.issue || '');
      const doi = this.cleanValue(fields.doi || '');
      const url = this.cleanValue(fields.url || '');
      const abstract = this.cleanValue(fields.abstract || '');
      const isbn = this.cleanValue(fields.isbn || '');
      const issn = this.cleanValue(fields.issn || '');

      entries.push({
        citationKey: citationKey || undefined,
        itemType,
        title,
        authors,
        year,
        journal: journal || undefined,
        publisher: publisher || undefined,
        volume: volume || undefined,
        issue: issue || undefined,
        pages: pages || undefined,
        doi: doi || undefined,
        isbn: isbn || undefined,
        issn: issn || undefined,
        url: url || undefined,
        abstract: abstract || undefined,
      });
    }

    return entries;
  }

  /**
   * Parse key-value fields inside BibTeX entry body
   */
  private parseFields(body: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const fieldRegex =
      /([a-zA-Z_-]+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|([^,}\n\r]+))/g;

    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      const key = fieldMatch[1].toLowerCase().trim();
      const value = fieldMatch[2] ?? fieldMatch[3] ?? fieldMatch[4] ?? '';
      fields[key] = value.trim();
    }

    return fields;
  }

  /**
   * Strip outer braces, quotes, and LaTeX formatting
   */
  private cleanValue(str: string): string {
    if (!str) return '';
    return str
      .replace(/^[\s{"']+|[\s}"']+$/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Map standard BibTeX types to application itemType
   */
  private mapBibtexTypeToItemType(type: string): string {
    switch (type.toLowerCase()) {
      case 'inproceedings':
      case 'conference':
        return 'conferencePaper';
      case 'book':
        return 'book';
      case 'incollection':
      case 'booksection':
        return 'bookSection';
      case 'phdthesis':
      case 'mastersthesis':
      case 'thesis':
        return 'thesis';
      case 'techreport':
      case 'report':
        return 'report';
      case 'online':
      case 'webpage':
        return 'webpage';
      case 'article':
      default:
        return 'journalArticle';
    }
  }
}
