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
  series?: string;
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
      // Skip comments or preamble
      if (
        rawType === 'comment' ||
        rawType === 'preamble' ||
        rawType === 'string'
      ) {
        continue;
      }

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
        const num = parseInt(
          this.cleanValue(fields.year).replace(/\D/g, ''),
          10,
        );
        if (!isNaN(num)) year = num;
      }

      const pages = fields.pages
        ? this.cleanValue(fields.pages).replace(/--/g, '-')
        : undefined;

      const title = this.cleanValue(fields.title || 'Untitled');
      const journal = this.cleanValue(fields.journal || fields.booktitle || '');
      const publisher = this.cleanValue(
        fields.publisher || fields.institution || fields.school || '',
      );
      const volume = this.cleanValue(fields.volume || '');
      const issue = this.cleanValue(fields.number || fields.issue || '');
      const doi = this.cleanValue(fields.doi || '');
      const url = this.cleanValue(fields.url || '');
      const abstract = this.cleanValue(fields.abstract || '');
      const isbn = this.cleanValue(fields.isbn || '');
      const issn = this.cleanValue(fields.issn || '');
      const series = this.cleanValue(fields.series || '');

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
        series: series || undefined,
      });
    }

    return entries;
  }

  /**
   * Parse key-value fields inside BibTeX entry body handling arbitrary nested braces
   */
  private parseFields(body: string): Record<string, string> {
    const fields: Record<string, string> = {};
    let i = 0;

    while (i < body.length) {
      // Skip whitespace, commas, and newlines
      while (i < body.length && /[\s,]/.test(body[i])) i++;
      if (i >= body.length) break;

      // Read key
      const keyStart = i;
      while (i < body.length && /[a-zA-Z0-9_\-]/.test(body[i])) i++;
      const key = body.slice(keyStart, i).toLowerCase().trim();
      if (!key) {
        i++;
        continue;
      }

      // Skip whitespace to '='
      while (i < body.length && /\s/.test(body[i])) i++;
      if (i >= body.length || body[i] !== '=') {
        continue;
      }
      i++; // Skip '='

      // Skip whitespace to value
      while (i < body.length && /\s/.test(body[i])) i++;
      if (i >= body.length) break;

      let value = '';
      if (body[i] === '{') {
        // Balanced braces parsing
        let depth = 1;
        const valStart = i + 1;
        i++;
        while (i < body.length && depth > 0) {
          if (body[i] === '{') depth++;
          else if (body[i] === '}') depth--;
          i++;
        }
        value = body.slice(valStart, depth === 0 ? i - 1 : i);
      } else if (body[i] === '"') {
        // Quoted string parsing
        const valStart = i + 1;
        i++;
        while (i < body.length && body[i] !== '"') {
          if (body[i] === '\\' && i + 1 < body.length) i += 2;
          else i++;
        }
        value = body.slice(valStart, i);
        if (i < body.length && body[i] === '"') i++;
      } else {
        // Unquoted value
        const valStart = i;
        while (
          i < body.length &&
          body[i] !== ',' &&
          body[i] !== '\n' &&
          body[i] !== '\r' &&
          body[i] !== '}'
        ) {
          i++;
        }
        value = body.slice(valStart, i).trim();
      }

      fields[key] = value;
    }

    return fields;
  }

  /**
   * Strip outer braces, quotes, and decode LaTeX diacritics
   */
  private cleanValue(str: string): string {
    if (!str) return '';
    let cleaned = str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Strip matched outer quotes
    if (
      cleaned.startsWith('"') &&
      cleaned.endsWith('"') &&
      cleaned.length >= 2
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }

    // Strip outer balanced braces if wrapped entirely
    while (
      cleaned.startsWith('{') &&
      cleaned.endsWith('}') &&
      cleaned.length >= 2
    ) {
      let depth = 0;
      let wrapsEntire = true;
      for (let j = 0; j < cleaned.length - 1; j++) {
        if (cleaned[j] === '{') depth++;
        else if (cleaned[j] === '}') depth--;
        if (depth === 0) {
          wrapsEntire = false;
          break;
        }
      }
      if (wrapsEntire) {
        cleaned = cleaned.slice(1, -1).trim();
      } else {
        break;
      }
    }

    // LaTeX accent mappings
    const accentMap: Record<string, string> = {
      "'e": 'é',
      "'a": 'á',
      "'o": 'ó',
      "'i": 'í',
      "'u": 'ú',
      "'c": 'ć',
      '`e': 'è',
      '`a': 'à',
      '`o': 'ò',
      '`u': 'ù',
      '^e': 'ê',
      '^a': 'â',
      '^o': 'ô',
      '^i': 'î',
      '^u': 'û',
      '"a': 'ä',
      '"o': 'ö',
      '"u': 'ü',
      '"e': 'ë',
      '"i': 'ï',
      '~a': 'ã',
      '~o': 'õ',
      '~n': 'ñ',
      'c{c}': 'ç',
      'c c': 'ç',
      'acute{e}': 'é',
      'grave{e}': 'è',
      'circ{e}': 'ê',
      'tilde{a}': 'ã',
      'H{o}': 'ő',
    };

    // Decode {\\command} or \\command
    for (const [tex, unicode] of Object.entries(accentMap)) {
      const escapedTex = tex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(
        new RegExp(`\\{\\\\${escapedTex}\\}|\\\\${escapedTex}`, 'g'),
        unicode,
      );
    }

    cleaned = cleaned
      .replace(/\{\\ss\}|\\ss\b/g, 'ß')
      .replace(/\\&/g, '&')
      .replace(/\\%/g, '%')
      .replace(/\\\$/g, '$')
      .replace(/\\_/g, '_')
      .replace(/\\#/g, '#');

    // Remove inner braces used for case preservation {{BERT}} -> BERT
    cleaned = cleaned.replace(/\{([^{}]+)\}/g, '$1');
    cleaned = cleaned.replace(/\{([^{}]+)\}/g, '$1');
    cleaned = cleaned.replace(/[{}]/g, '');

    return cleaned.trim();
  }

  /**
   * Map standard BibTeX types to application itemType
   */
  private mapBibtexTypeToItemType(type: string): string {
    switch (type.toLowerCase()) {
      case 'inproceedings':
      case 'conference':
      case 'proceedings':
        return 'conferencePaper';
      case 'book':
        return 'book';
      case 'incollection':
      case 'booksection':
      case 'chapter':
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
      case 'misc':
      case 'preprint':
        return 'webpage';
      case 'article':
      default:
        return 'journalArticle';
    }
  }
}
