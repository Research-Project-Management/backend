import { Injectable } from '@nestjs/common';
import { CatalogItem } from '@prisma/client';
import {
  extractFamilyName,
  extractMeaningfulTitleWord,
} from '../utils/cite.util';

export type BibtexSource = Partial<
  Pick<
    CatalogItem,
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
    | 'extra'
    | 'series'
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
   * Generates a standard AuthorYearTitle CitationKey conforming to Better BibTeX spec:
   * e.g. "vaswani2017attention", "he2016deep"
   */
  generateCitationKey(
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
   * Maps itemType to standard BibTeX entry type
   */
  private getBibtexEntryType(itemType?: string | null): string {
    switch (itemType?.toLowerCase()) {
      case 'book':
        return 'book';
      case 'booksection':
      case 'incollection':
      case 'chapter':
        return 'incollection';
      case 'conferencepaper':
      case 'inproceedings':
      case 'proceedings':
        return 'inproceedings';
      case 'thesis':
      case 'phdthesis':
        return 'phdthesis';
      case 'mastersthesis':
        return 'mastersthesis';
      case 'report':
      case 'techreport':
        return 'techreport';
      case 'preprint':
      case 'online':
      case 'webpage':
        return 'online';
      case 'journalarticle':
      default:
        return 'article';
    }
  }

  /**
   * Formats a single CatalogItem metadata to a clean BibTeX block
   */
  formatEntry(CatalogItem: BibtexSource): string {
    const key =
      CatalogItem.citationKey?.trim() ||
      this.generateCitationKey(
        CatalogItem.title || '',
        CatalogItem.authors || [],
        CatalogItem.year,
      );

    const entryType = this.getBibtexEntryType(CatalogItem.itemType);
    const authorStr =
      CatalogItem.authors && CatalogItem.authors.length > 0
        ? CatalogItem.authors.join(' and ')
        : 'Unknown';

    let bib = `@${entryType}{${key},\n`;
    bib += `  title = {${this.escapeTex(CatalogItem.title || '')}},\n`;
    bib += `  author = {${authorStr}},\n`;

    if (CatalogItem.year) bib += `  year = {${CatalogItem.year}},\n`;
    if (CatalogItem.journal)
      bib += `  journal = {${this.escapeTex(CatalogItem.journal)}},\n`;
    if (CatalogItem.volume) bib += `  volume = {${CatalogItem.volume}},\n`;
    if (CatalogItem.issue) bib += `  number = {${CatalogItem.issue}},\n`;
    if (CatalogItem.pages) bib += `  pages = {${CatalogItem.pages}},\n`;
    if (CatalogItem.doi) bib += `  doi = {${CatalogItem.doi}},\n`;
    if (CatalogItem.publisher)
      bib += `  publisher = {${this.escapeTex(CatalogItem.publisher)}},\n`;
    if (CatalogItem.series)
      bib += `  series = {${this.escapeTex(CatalogItem.series)}},\n`;
    if (CatalogItem.url) bib += `  url = {${CatalogItem.url}},\n`;
    if (CatalogItem.issn) bib += `  issn = {${CatalogItem.issn}},\n`;
    if (CatalogItem.isbn) bib += `  isbn = {${CatalogItem.isbn}},\n`;
    if (CatalogItem.abstract)
      bib += `  abstract = {${this.escapeTex(CatalogItem.abstract)}},\n`;

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
