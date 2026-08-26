import { Injectable, Logger } from '@nestjs/common';
import { extractFamilyName } from '../utils/cite.util';

export type CitationStyle =
  'apa' | 'ieee' | 'nature' | 'harvard' | 'chicago' | 'mla' | 'vancouver';

export interface CslSourcePaper {
  id?: string;
  title: string;
  authors?: string[];
  year?: number | null;
  journal?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
  url?: string | null;
  itemType?: string | null;
  citationKey?: string | null;
  extra?: string | null;
  series?: string | null;
  place?: string | null;
  issn?: string | null;
  isbn?: string | null;
}

export interface CslJsonItem {
  id: string;
  type: string;
  title: string;
  'container-title'?: string;
  'short-container-title'?: string;
  publisher?: string;
  'publisher-place'?: string;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  URL?: string;
  ISSN?: string;
  ISBN?: string;
  author?: Array<{ family: string; given?: string; literal?: string }>;
  issued?: { 'date-parts': number[][] };
  note?: string;
}

export interface FormattedCitation {
  style: CitationStyle;
  inText: string;
  inTextHtml: string;
  bibliography: string;
  bibliographyHtml: string;
}

@Injectable()
export class CslFormatter {
  private readonly logger = new Logger(CslFormatter.name);

  /**
   * Converts internal paper model into standard CSL-JSON v1.0.2 Item
   */
  toCslJson(paper: CslSourcePaper): CslJsonItem {
    const authors = (paper.authors || []).map((a) => {
      const parsed = this.parseAuthorName(a);
      if (!parsed.given && !parsed.family.includes(' ')) {
        return { family: parsed.family };
      }
      return {
        family: parsed.family || 'Anonymous',
        given: parsed.given || undefined,
      };
    });

    const cslType = this.mapItemTypeToCsl(paper.itemType);

    const cslItem: CslJsonItem = {
      id: paper.id || paper.citationKey || 'item-1',
      type: cslType,
      title: paper.title ? paper.title.trim().replace(/\.$/, '') : 'Untitled',
      'container-title': paper.journal?.trim() || undefined,
      publisher: paper.publisher?.trim() || undefined,
      'publisher-place': paper.place?.trim() || undefined,
      volume: paper.volume?.trim() || undefined,
      issue: paper.issue?.trim() || undefined,
      page: paper.pages?.trim() || undefined,
      DOI: paper.doi?.trim() || undefined,
      URL: paper.url?.trim() || undefined,
      ISSN: paper.issn?.trim() || undefined,
      ISBN: paper.isbn?.trim() || undefined,
      author: authors.length ? authors : undefined,
    };

    if (paper.year) {
      cslItem.issued = {
        'date-parts': [[paper.year]],
      };
    }

    if (paper.extra) {
      cslItem.note = paper.extra;
    }

    return cslItem;
  }

  /**
   * Format single paper entry in chosen style
   */
  formatEntry(
    paper: CslSourcePaper,
    style: CitationStyle = 'apa',
    index: number = 1,
  ): FormattedCitation {
    const authors = paper.authors || [];
    const year = paper.year ? String(paper.year) : 'n.d.';
    const title = paper.title
      ? paper.title.trim().replace(/\.$/, '')
      : 'Untitled';
    const journal = paper.journal ? paper.journal.trim() : '';
    const volume = paper.volume ? paper.volume.trim() : '';
    const issue = paper.issue ? paper.issue.trim() : '';
    const pages = paper.pages ? paper.pages.trim() : '';
    const doi = paper.doi ? paper.doi.trim() : '';
    const doiUrl = doi
      ? doi.startsWith('http')
        ? doi
        : `https://doi.org/${doi}`
      : '';

    switch (style.toLowerCase() as CitationStyle) {
      case 'ieee':
        return this.formatIeee(
          paper,
          index,
          authors,
          year,
          title,
          journal,
          volume,
          issue,
          pages,
          doiUrl,
        );
      case 'nature':
        return this.formatNature(
          paper,
          authors,
          year,
          title,
          journal,
          volume,
          pages,
          doiUrl,
        );
      case 'harvard':
        return this.formatHarvard(
          paper,
          authors,
          year,
          title,
          journal,
          volume,
          issue,
          pages,
          doiUrl,
        );
      case 'chicago':
        return this.formatChicago(
          paper,
          authors,
          year,
          title,
          journal,
          volume,
          issue,
          pages,
          doiUrl,
        );
      case 'mla':
        return this.formatMla(
          paper,
          authors,
          year,
          title,
          journal,
          volume,
          issue,
          pages,
          doiUrl,
        );
      case 'vancouver':
        return this.formatVancouver(
          paper,
          index,
          authors,
          year,
          title,
          journal,
          volume,
          issue,
          pages,
          doiUrl,
        );
      case 'apa':
      default:
        return this.formatApa(
          paper,
          authors,
          year,
          title,
          journal,
          volume,
          issue,
          pages,
          doiUrl,
        );
    }
  }

  private mapItemTypeToCsl(itemType?: string | null): string {
    switch (itemType?.toLowerCase()) {
      case 'conferencepaper':
      case 'inproceedings':
        return 'paper-conference';
      case 'book':
        return 'book';
      case 'booksection':
      case 'incollection':
      case 'chapter':
        return 'chapter';
      case 'thesis':
      case 'phdthesis':
        return 'thesis';
      case 'report':
      case 'techreport':
        return 'report';
      case 'webpage':
      case 'online':
        return 'webpage';
      case 'journalarticle':
      default:
        return 'article-journal';
    }
  }

  /**
   * APA 7th Edition:
   * In-text: (Vaswani et al., 2017)
   * Bib: Vaswani, A., Shazeer, N., & Parmar, N. (2017). Attention is all you need. Neural Information Processing Systems, 30, 1-11. https://doi.org/...
   */
  private formatApa(
    paper: CslSourcePaper,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    issue: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inTextAuthor = this.getInTextAuthor(authors, 'apa');
    const inText = `(${inTextAuthor}, ${year})`;

    // Format author list: "Last, F. M., & Last, F."
    const formattedAuthors = this.formatAuthorsApa(authors);
    const authorPart = formattedAuthors ? `${formattedAuthors} ` : '';

    let bibText = `${authorPart}(${year}). ${title}.`;
    let bibHtml = `${authorPart}(${year}). ${title}.`;

    if (journal) {
      bibText += ` ${journal}`;
      bibHtml += ` <i>${journal}</i>`;
      if (volume) {
        bibText += `, ${volume}`;
        bibHtml += `, <i>${volume}</i>`;
        if (issue) {
          bibText += `(${issue})`;
          bibHtml += `(${issue})`;
        }
      }
      if (pages) {
        bibText += `, ${pages}.`;
        bibHtml += `, ${pages}.`;
      } else {
        bibText += '.';
        bibHtml += '.';
      }
    } else if (paper.publisher) {
      bibText += ` ${paper.publisher}.`;
      bibHtml += ` ${paper.publisher}.`;
    }

    if (doiUrl) {
      bibText += ` ${doiUrl}`;
      bibHtml += ` <a href="${doiUrl}" target="_blank" rel="noreferrer">${doiUrl}</a>`;
    }

    return {
      style: 'apa',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  /**
   * IEEE Style:
   * In-text: [1]
   * Bib: [1] A. Vaswani, N. Shazeer, and N. Parmar, "Attention is all you need," Neural Information Processing Systems, vol. 30, pp. 1-11, 2017.
   */
  private formatIeee(
    paper: CslSourcePaper,
    index: number,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    issue: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inText = `[${index}]`;
    const formattedAuthors = this.formatAuthorsIeee(authors);
    const authorPart = formattedAuthors ? `${formattedAuthors}, ` : '';

    let bibText = `[${index}] ${authorPart}"${title},"`;
    let bibHtml = `[${index}] ${authorPart}"${title},"`;

    if (journal) {
      bibText += ` ${journal}`;
      bibHtml += ` <i>${journal}</i>`;
      if (volume) {
        bibText += `, vol. ${volume}`;
        bibHtml += `, vol. ${volume}`;
      }
      if (issue) {
        bibText += `, no. ${issue}`;
        bibHtml += `, no. ${issue}`;
      }
      if (pages) {
        bibText += `, pp. ${pages}`;
        bibHtml += `, pp. ${pages}`;
      }
      bibText += `, ${year}.`;
      bibHtml += `, ${year}.`;
    } else {
      bibText += ` ${year}.`;
      bibHtml += ` ${year}.`;
    }

    if (doiUrl) {
      bibText += ` doi: ${paper.doi}.`;
      bibHtml += ` doi: <a href="${doiUrl}" target="_blank" rel="noreferrer">${paper.doi}</a>.`;
    }

    return {
      style: 'ieee',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  /**
   * Nature Style:
   * In-text: 1 (or Vaswani et al.)
   * Bib: Vaswani, A. et al. Attention is all you need. Nature 30, 1-11 (2017).
   */
  private formatNature(
    paper: CslSourcePaper,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inTextAuthor = this.getInTextAuthor(authors, 'nature');
    const inText = `${inTextAuthor} (${year})`;

    const authorPart = this.formatAuthorsNature(authors);
    let bibText = `${authorPart} ${title}.`;
    let bibHtml = `${authorPart} ${title}.`;

    if (journal) {
      bibText += ` ${journal}`;
      bibHtml += ` <i>${journal}</i>`;
      if (volume) {
        bibText += ` ${volume}`;
        bibHtml += ` <b>${volume}</b>`;
      }
      if (pages) {
        bibText += `, ${pages}`;
        bibHtml += `, ${pages}`;
      }
      bibText += ` (${year}).`;
      bibHtml += ` (${year}).`;
    } else {
      bibText += ` (${year}).`;
      bibHtml += ` (${year}).`;
    }

    return {
      style: 'nature',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  /**
   * Harvard Style:
   * In-text: (Vaswani et al., 2017)
   * Bib: Vaswani, A., Shazeer, N. and Parmar, N., 2017. Attention is all you need. Neural Information Processing Systems, 30, pp.1-11.
   */
  private formatHarvard(
    paper: CslSourcePaper,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    issue: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inText = `(${this.getInTextAuthor(authors, 'harvard')}, ${year})`;
    const formattedAuthors = this.formatAuthorsHarvard(authors);

    let bibText = `${formattedAuthors}, ${year}. ${title}.`;
    let bibHtml = `${formattedAuthors}, ${year}. ${title}.`;

    if (journal) {
      bibText += ` ${journal}`;
      bibHtml += ` <i>${journal}</i>`;
      if (volume) {
        bibText += `, ${volume}`;
        bibHtml += `, ${volume}`;
        if (issue) {
          bibText += `(${issue})`;
          bibHtml += `(${issue})`;
        }
      }
      if (pages) {
        bibText += `, pp.${pages}.`;
        bibHtml += `, pp.${pages}.`;
      } else {
        bibText += '.';
        bibHtml += '.';
      }
    }

    return {
      style: 'harvard',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  /**
   * Chicago Style (Author-Date)
   */
  private formatChicago(
    paper: CslSourcePaper,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    issue: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inText = `(${this.getInTextAuthor(authors, 'chicago')} ${year})`;
    const formattedAuthors = this.formatAuthorsChicago(authors);

    let bibText = `${formattedAuthors}. ${year}. "${title}."`;
    let bibHtml = `${formattedAuthors}. ${year}. "${title}."`;

    if (journal) {
      bibText += ` ${journal}`;
      bibHtml += ` <i>${journal}</i>`;
      if (volume) {
        bibText += ` ${volume}`;
        bibHtml += ` ${volume}`;
        if (issue) {
          bibText += `, no. ${issue}`;
          bibHtml += `, no. ${issue}`;
        }
      }
      if (pages) {
        bibText += `: ${pages}.`;
        bibHtml += `: ${pages}.`;
      } else {
        bibText += '.';
        bibHtml += '.';
      }
    }

    if (doiUrl) {
      bibText += ` ${doiUrl}.`;
      bibHtml += ` <a href="${doiUrl}" target="_blank" rel="noreferrer">${doiUrl}</a>.`;
    }

    return {
      style: 'chicago',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  /**
   * MLA 9th Edition
   */
  private formatMla(
    paper: CslSourcePaper,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    issue: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inText = `(${this.getInTextAuthor(authors, 'mla')})`;
    const formattedAuthors = this.formatAuthorsMla(authors);

    let bibText = `${formattedAuthors}. "${title}."`;
    let bibHtml = `${formattedAuthors}. "${title}."`;

    if (journal) {
      bibText += ` ${journal}`;
      bibHtml += ` <i>${journal}</i>`;
      if (volume) {
        bibText += `, vol. ${volume}`;
        bibHtml += `, vol. ${volume}`;
      }
      if (issue) {
        bibText += `, no. ${issue}`;
        bibHtml += `, no. ${issue}`;
      }
      bibText += `, ${year}`;
      bibHtml += `, ${year}`;
      if (pages) {
        bibText += `, pp. ${pages}.`;
        bibHtml += `, pp. ${pages}.`;
      } else {
        bibText += '.';
        bibHtml += '.';
      }
    }

    return {
      style: 'mla',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  /**
   * Vancouver Style
   */
  private formatVancouver(
    paper: CslSourcePaper,
    index: number,
    authors: string[],
    year: string,
    title: string,
    journal: string,
    volume: string,
    issue: string,
    pages: string,
    doiUrl: string,
  ): FormattedCitation {
    const inText = `(${index})`;
    const formattedAuthors = this.formatAuthorsVancouver(authors);

    let bibText = `${index}. ${formattedAuthors}. ${title}.`;
    let bibHtml = `${index}. ${formattedAuthors}. ${title}.`;

    if (journal) {
      bibText += ` ${journal}. ${year}`;
      bibHtml += ` <i>${journal}</i>. ${year}`;
      if (volume) {
        bibText += `;${volume}`;
        bibHtml += `;${volume}`;
        if (issue) {
          bibText += `(${issue})`;
          bibHtml += `(${issue})`;
        }
      }
      if (pages) {
        bibText += `:${pages}.`;
        bibHtml += `:${pages}.`;
      } else {
        bibText += '.';
        bibHtml += '.';
      }
    }

    return {
      style: 'vancouver',
      inText,
      inTextHtml: inText,
      bibliography: bibText.trim(),
      bibliographyHtml: bibHtml.trim(),
    };
  }

  // --- Author Formatting Helpers ---

  private getInTextAuthor(authors: string[], style: string): string {
    if (!authors || authors.length === 0) return 'Anonymous';
    const firstFam = extractFamilyName(authors[0]) || 'Author';

    if (authors.length === 1) {
      return this.capitalize(firstFam);
    }
    if (authors.length === 2) {
      const secondFam = extractFamilyName(authors[1]) || 'Author';
      const conj = style === 'apa' ? '&' : 'and';
      return `${this.capitalize(firstFam)} ${conj} ${this.capitalize(secondFam)}`;
    }
    return `${this.capitalize(firstFam)} et al.`;
  }

  private parseAuthorName(raw: string): { family: string; given: string } {
    if (!raw) return { family: '', given: '' };
    if (raw.includes(',')) {
      const [fam, giv] = raw.split(',');
      return { family: fam.trim(), given: (giv || '').trim() };
    }
    const parts = raw.trim().split(/\s+/);
    if (parts.length === 1) return { family: parts[0], given: '' };
    const family = parts.pop() || '';
    const given = parts.join(' ');
    return { family, given };
  }

  private formatAuthorsApa(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    const formatted = authors.map((a) => {
      const { family, given } = this.parseAuthorName(a);
      const initials = given
        ? given
            .split(/\s+/)
            .map((g) => `${g[0].toUpperCase()}.`)
            .join(' ')
        : '';
      return initials ? `${family}, ${initials}` : family;
    });

    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return `${formatted[0]} & ${formatted[1]}`;
    if (formatted.length <= 20) {
      return `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
    }
    return `${formatted.slice(0, 19).join(', ')} ... ${formatted[formatted.length - 1]}`;
  }

  private formatAuthorsIeee(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    const formatted = authors.map((a) => {
      const { family, given } = this.parseAuthorName(a);
      const initials = given
        ? given
            .split(/\s+/)
            .map((g) => `${g[0].toUpperCase()}.`)
            .join(' ')
        : '';
      return initials ? `${initials} ${family}` : family;
    });

    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return `${formatted[0]} and ${formatted[1]}`;
    if (formatted.length <= 6) {
      return `${formatted.slice(0, -1).join(', ')}, and ${formatted[formatted.length - 1]}`;
    }
    return `${formatted[0]} et al.`;
  }

  private formatAuthorsNature(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    if (authors.length === 1) {
      const { family, given } = this.parseAuthorName(authors[0]);
      const initial = given ? ` ${given[0].toUpperCase()}.` : '';
      return `${family},${initial}`;
    }
    if (authors.length <= 5) {
      return authors
        .map((a) => {
          const { family, given } = this.parseAuthorName(a);
          const initial = given ? ` ${given[0].toUpperCase()}.` : '';
          return `${family},${initial}`;
        })
        .join(', ');
    }
    const { family, given } = this.parseAuthorName(authors[0]);
    const initial = given ? ` ${given[0].toUpperCase()}.` : '';
    return `${family},${initial} et al.`;
  }

  private formatAuthorsHarvard(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    const formatted = authors.map((a) => {
      const { family, given } = this.parseAuthorName(a);
      const initials = given
        ? given
            .split(/\s+/)
            .map((g) => `${g[0].toUpperCase()}.`)
            .join('')
        : '';
      return initials ? `${family}, ${initials}` : family;
    });

    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return `${formatted[0]} and ${formatted[1]}`;
    return `${formatted.slice(0, -1).join(', ')} and ${formatted[formatted.length - 1]}`;
  }

  private formatAuthorsChicago(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    const first = this.parseAuthorName(authors[0]);
    const firstStr = first.given
      ? `${first.family}, ${first.given}`
      : first.family;

    if (authors.length === 1) return firstStr;

    const rest = authors.slice(1).map((a) => {
      const { family, given } = this.parseAuthorName(a);
      return given ? `${given} ${family}` : family;
    });

    if (rest.length === 1) return `${firstStr}, and ${rest[0]}`;
    return `${firstStr}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`;
  }

  private formatAuthorsMla(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    const first = this.parseAuthorName(authors[0]);
    const firstStr = first.given
      ? `${first.family}, ${first.given}`
      : first.family;

    if (authors.length === 1) return firstStr;
    if (authors.length === 2) {
      const second = this.parseAuthorName(authors[1]);
      const secStr = second.given
        ? `${second.given} ${second.family}`
        : second.family;
      return `${firstStr}, and ${secStr}`;
    }
    return `${firstStr}, et al`;
  }

  private formatAuthorsVancouver(authors: string[]): string {
    if (!authors || authors.length === 0) return '';
    const formatted = authors.map((a) => {
      const { family, given } = this.parseAuthorName(a);
      const initials = given
        ? given
            .split(/\s+/)
            .map((g) => g[0].toUpperCase())
            .join('')
        : '';
      return initials ? `${family} ${initials}` : family;
    });

    if (formatted.length <= 6) return formatted.join(', ');
    return `${formatted.slice(0, 6).join(', ')}, et al`;
  }

  private capitalize(s: string): string {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
