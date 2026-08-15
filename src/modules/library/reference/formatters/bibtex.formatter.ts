import { Injectable } from '@nestjs/common';
import { Paper } from '@prisma/client';

export type BibtexSource = Partial<
  Pick<
    Paper,
    | 'title'
    | 'authors'
    | 'year'
    | 'doi'
    | 'journal'
    | 'volume'
    | 'issue'
    | 'pages'
    | 'publisher'
    | 'itemType'
    | 'citationKey'
    | 'url'
    | 'isbn'
    | 'issn'
    | 'abstract'
  >
>;

@Injectable()
export class BibtexFormatter {
  /**
   * Escape special TeX characters safely
   */
  escapeTex(str: string): string {
    if (!str) return '';
    return str
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/([&%$#_{}])/g, '\\$1')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  }

  /**
   * Generates a standard AuthorYearTitle CitationKey (e.g. vaswani2017attention)
   */
  generateCitationKey(
    title: string,
    authors: string[] = [],
    year?: number | null,
  ): string {
    let firstAuthor = 'author';
    if (authors && authors.length > 0 && typeof authors[0] === 'string') {
      const name = authors[0].trim();
      const parts = name.split(/[\s,]+/);
      firstAuthor =
        parts[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'author';
    }
    const cleanYear = year ? String(year) : new Date().getFullYear().toString();
    const cleanTitleWord =
      (title || 'paper')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .find((w) => w.length > 3) || 'doc';

    return `${firstAuthor}${cleanYear}${cleanTitleWord}`;
  }

  /**
   * Maps itemType to standard BibTeX entry type
   */
  private getBibtexEntryType(itemType?: string | null): string {
    switch (itemType?.toLowerCase()) {
      case 'book':
        return 'book';
      case 'booksection':
      case 'incollection':
        return 'incollection';
      case 'conferencepaper':
      case 'inproceedings':
        return 'inproceedings';
      case 'thesis':
      case 'phdthesis':
        return 'phdthesis';
      case 'report':
      case 'techreport':
        return 'techreport';
      case 'webpage':
      case 'online':
        return 'online';
      case 'journalarticle':
      default:
        return 'article';
    }
  }

  /**
   * Formats a single paper metadata to a clean BibTeX block
   */
  formatEntry(paper: BibtexSource): string {
    const key =
      paper.citationKey?.trim() ||
      this.generateCitationKey(
        paper.title || '',
        paper.authors || [],
        paper.year,
      );

    const entryType = this.getBibtexEntryType(paper.itemType);
    const authorStr =
      paper.authors && paper.authors.length > 0
        ? paper.authors.join(' and ')
        : 'Unknown';

    let bib = `@${entryType}{${key},\n`;
    bib += `  title = {${this.escapeTex(paper.title || '')}},\n`;
    bib += `  author = {${authorStr}},\n`;

    if (paper.year) bib += `  year = {${paper.year}},\n`;
    if (paper.journal)
      bib += `  journal = {${this.escapeTex(paper.journal)}},\n`;
    if (paper.volume) bib += `  volume = {${paper.volume}},\n`;
    if (paper.issue) bib += `  number = {${paper.issue}},\n`;
    if (paper.pages) bib += `  pages = {${paper.pages}},\n`;
    if (paper.doi) bib += `  doi = {${paper.doi}},\n`;
    if (paper.publisher)
      bib += `  publisher = {${this.escapeTex(paper.publisher)}},\n`;
    if (paper.url) bib += `  url = {${paper.url}},\n`;
    if (paper.issn) bib += `  issn = {${paper.issn}},\n`;
    if (paper.isbn) bib += `  isbn = {${paper.isbn}},\n`;

    bib += `}\n`;
    return bib;
  }

  /**
   * Formats an array of papers to a complete .bib file string
   */
  formatMultiple(papers: BibtexSource[]): string {
    return papers.map((p) => this.formatEntry(p)).join('\n');
  }
}
