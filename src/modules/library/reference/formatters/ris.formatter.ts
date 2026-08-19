import { Injectable } from '@nestjs/common';

export interface RisReferenceData {
  title: string;
  authors: string[];
  year: number | null;
  doi?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  url?: string;
  keywords?: string[];
  itemType: string;
}

@Injectable()
export class RisFormatter {
  /**
   * Parse standard RIS text content into structured RisReferenceData records
   */
  parse(risContent: string): RisReferenceData[] {
    if (!risContent || typeof risContent !== 'string') return [];

    const entries: RisReferenceData[] = [];
    const rawRecords = risContent.split(/(?:^|\n)ER\s{2}-/g);

    for (const record of rawRecords) {
      const lines = record.split('\n');
      let currentType = 'journalArticle';
      let title = '';
      const authors: string[] = [];
      let year: number | null = null;
      let doi = '';
      let journal = '';
      let publisher = '';
      let volume = '';
      let issue = '';
      let startPage = '';
      let endPage = '';
      let abstract = '';
      let url = '';
      const keywords: string[] = [];

      for (const line of lines) {
        const match = line.match(/^([A-Z0-9]{2})\s{2}-\s*(.*)$/);
        if (!match) continue;

        const [, tag, rawVal] = match;
        const val = rawVal.trim();
        if (!val) continue;

        switch (tag) {
          case 'TY':
            currentType = this.mapRisTypeToItemType(val);
            break;
          case 'TI':
          case 'T1':
          case 'CT':
            title = val;
            break;
          case 'AU':
          case 'A1':
          case 'ED':
            authors.push(val);
            break;
          case 'PY':
          case 'Y1':
          case 'DA': {
            const yearMatch = val.match(/\b(19\d{2}|20\d{2})\b/);
            if (yearMatch) year = parseInt(yearMatch[1], 10);
            break;
          }
          case 'DO':
            doi = val.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
            break;
          case 'JO':
          case 'JF':
          case 'JA':
          case 'J2':
          case 'T2':
            journal = val;
            break;
          case 'PB':
            publisher = val;
            break;
          case 'VL':
            volume = val;
            break;
          case 'IS':
            issue = val;
            break;
          case 'SP':
            startPage = val;
            break;
          case 'EP':
            endPage = val;
            break;
          case 'AB':
          case 'N2':
            abstract = val;
            break;
          case 'KW':
            keywords.push(val);
            break;
          case 'UR':
          case 'L1':
            url = val;
            break;
        }
      }

      if (title || doi || authors.length > 0) {
        const pages =
          startPage && endPage
            ? `${startPage}-${endPage}`
            : startPage || endPage || '';

        entries.push({
          title: title || 'Untitled RIS Record',
          authors,
          year,
          doi: doi || undefined,
          journal: journal || undefined,
          publisher: publisher || undefined,
          volume: volume || undefined,
          issue: issue || undefined,
          pages: pages || undefined,
          abstract: abstract || undefined,
          url: url || (doi ? `https://doi.org/${doi}` : undefined),
          keywords: keywords.length > 0 ? keywords : undefined,
          itemType: currentType,
        });
      }
    }

    return entries;
  }

  /**
   * Export paper into RIS format string
   */
  formatEntry(paper: any): string {
    const lines: string[] = [];
    lines.push(`TY  - ${this.mapItemTypeToRisType(paper.itemType)}`);
    lines.push(`TI  - ${paper.title}`);

    if (Array.isArray(paper.authors)) {
      for (const auth of paper.authors) {
        lines.push(`AU  - ${auth}`);
      }
    }

    if (paper.year) {
      lines.push(`PY  - ${paper.year}`);
    }

    if (paper.doi) {
      lines.push(`DO  - ${paper.doi}`);
    }

    if (paper.journal) {
      lines.push(`JO  - ${paper.journal}`);
    }

    if (paper.publisher) {
      lines.push(`PB  - ${paper.publisher}`);
    }

    if (paper.volume) {
      lines.push(`VL  - ${paper.volume}`);
    }

    if (paper.issue) {
      lines.push(`IS  - ${paper.issue}`);
    }

    if (paper.pages) {
      lines.push(`SP  - ${paper.pages}`);
    }

    if (paper.abstract) {
      lines.push(`AB  - ${paper.abstract}`);
    }

    if (paper.url) {
      lines.push(`UR  - ${paper.url}`);
    }

    lines.push('ER  - ');
    return lines.join('\n');
  }

  private mapRisTypeToItemType(risType: string): string {
    switch (risType.toUpperCase()) {
      case 'JOUR':
        return 'journalArticle';
      case 'BOOK':
        return 'book';
      case 'CHAP':
        return 'bookSection';
      case 'CONF':
        return 'conferencePaper';
      case 'THES':
        return 'thesis';
      case 'RPRT':
        return 'report';
      case 'PREP':
        return 'preprint';
      default:
        return 'journalArticle';
    }
  }

  private mapItemTypeToRisType(itemType?: string): string {
    switch (itemType) {
      case 'journalArticle':
        return 'JOUR';
      case 'book':
        return 'BOOK';
      case 'bookSection':
        return 'CHAP';
      case 'conferencePaper':
        return 'CONF';
      case 'thesis':
        return 'THES';
      case 'report':
        return 'RPRT';
      case 'preprint':
        return 'PREP';
      default:
        return 'JOUR';
    }
  }
}
