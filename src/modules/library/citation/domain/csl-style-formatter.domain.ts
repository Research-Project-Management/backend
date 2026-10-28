import {
  CslItemData,
  CslName,
} from '@/modules/library/citation/types/csl-json.types';

export interface ICslFallbackFormatter {
  fallbackBibtex(item: CslItemData): string;
  fallbackRis(item: CslItemData): string;
}

export const BIBTEX_ITEM_TYPE_MAP: Record<string, string> = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'incollection',
  dictionaryEntry: 'incollection',
  encyclopediaArticle: 'incollection',
  conferencePaper: 'inproceedings',
  report: 'techreport',
  patent: 'patent',
  dataset: 'dataset',
  computerProgram: 'software',
  standard: 'standard',
  webpage: 'online',
  blogPost: 'online',
  forumPost: 'online',
  preprint: 'unpublished',
  manuscript: 'unpublished',
  case: 'jurisdiction',
  statute: 'legislation',
  bill: 'legislation',
};

export const BIBTEX_CSL_TYPE_MAP: Record<string, string> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  'paper-conference': 'inproceedings',
  book: 'book',
  chapter: 'incollection',
  'entry-dictionary': 'incollection',
  'entry-encyclopedia': 'incollection',
  report: 'techreport',
  thesis: 'phdthesis',
  patent: 'patent',
  dataset: 'dataset',
  software: 'software',
  standard: 'standard',
  webpage: 'online',
  'post-weblog': 'online',
  post: 'online',
  manuscript: 'unpublished',
  article: 'unpublished',
  legal_case: 'jurisdiction',
  legislation: 'legislation',
  bill: 'legislation',
};

export const RIS_ITEM_TYPE_MAP: Record<string, string> = {
  journalArticle: 'JOUR',
  magazineArticle: 'MGZN',
  newspaperArticle: 'NEWS',
  book: 'BOOK',
  bookSection: 'CHAP',
  dictionaryEntry: 'DICT',
  encyclopediaArticle: 'ENCYC',
  conferencePaper: 'CONF',
  thesis: 'THES',
  report: 'RPRT',
  patent: 'PAT',
  dataset: 'DATA',
  computerProgram: 'COMP',
  standard: 'STAND',
  webpage: 'ELEC',
  blogPost: 'BLOG',
  forumPost: 'ELEC',
  preprint: 'UNPB',
  manuscript: 'UNPB',
  case: 'CASE',
  statute: 'STAT',
  bill: 'BILL',
  hearing: 'HEAR',
  letter: 'PCOMM',
  interview: 'INTV',
  film: 'MPCT',
  videoRecording: 'VIDEO',
  audioRecording: 'SOUND',
  artwork: 'ART',
  map: 'MAP',
  presentation: 'SLIDE',
};

export const RIS_CSL_TYPE_MAP: Record<string, string> = {
  'article-journal': 'JOUR',
  'article-magazine': 'MGZN',
  'article-newspaper': 'NEWS',
  'paper-conference': 'CONF',
  book: 'BOOK',
  chapter: 'CHAP',
  report: 'RPRT',
  thesis: 'THES',
  patent: 'PAT',
  dataset: 'DATA',
  software: 'COMP',
  standard: 'STAND',
  webpage: 'ELEC',
  'post-weblog': 'BLOG',
  post: 'ELEC',
  manuscript: 'UNPB',
  legal_case: 'CASE',
  legislation: 'STAT',
  bill: 'BILL',
};

export class CslFallbackFormatter implements ICslFallbackFormatter {
  public sanitizeBibtexKey(rawId?: string): string {
    const cleaned = String(rawId || '').replace(/[\s,{}\\~#%]+/g, '');
    return cleaned || 'ref';
  }

  public escapeBibtexValue(val: string | number, fieldKey?: string): string {
    const str = String(val ?? '');
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const prev = i > 0 ? str[i - 1] : '';
      if (ch === '{' && prev !== '\\') {
        depth++;
      } else if (ch === '}' && prev !== '\\') {
        depth--;
        if (depth < 0) {
          balanced = false;
          break;
        }
      }
    }
    if (depth !== 0) {
      balanced = false;
    }
    let out = !balanced ? str.replace(/(?<!\\)([{}])/g, '\\$1') : str;

    const lowerField = (fieldKey || '').toLowerCase();
    const isVerbatimField =
      lowerField === 'url' ||
      lowerField === 'doi' ||
      lowerField === 'eprint' ||
      /^(?:https?:\/\/|ftp:\/\/|10\.\d{4,9}\/)/i.test(out.trim());

    if (!isVerbatimField) {
      const segments = out.split(/(\$[^$]+\$)/g);
      out = segments
        .map((seg) => {
          if (seg.startsWith('$') && seg.endsWith('$') && seg.length >= 2) {
            return seg;
          }
          return seg.replace(/(?<!\\)([%&#_])/g, '\\$1');
        })
        .join('');
    }
    return out;
  }

  public resolveBibtexEntryType(cslItem: CslItemData): string {
    const rawItemType =
      typeof cslItem._itemType === 'string' ? cslItem._itemType : '';
    const genre = typeof cslItem.genre === 'string' ? cslItem.genre : '';

    if (rawItemType === 'thesis' || cslItem.type === 'thesis') {
      return /\b(?:master|m\.?s\.?|m\.?a\.?|m\.?eng|m\.?sc|thạc\s*sĩ)\b/i.test(
        genre,
      )
        ? 'mastersthesis'
        : 'phdthesis';
    }
    if (rawItemType && BIBTEX_ITEM_TYPE_MAP[rawItemType]) {
      return BIBTEX_ITEM_TYPE_MAP[rawItemType];
    }
    return BIBTEX_CSL_TYPE_MAP[cslItem.type] || 'misc';
  }

  public resolveRisType(cslItem: CslItemData): string {
    const rawItemType =
      typeof cslItem._itemType === 'string' ? cslItem._itemType : '';
    if (rawItemType && RIS_ITEM_TYPE_MAP[rawItemType]) {
      return RIS_ITEM_TYPE_MAP[rawItemType];
    }
    return RIS_CSL_TYPE_MAP[cslItem.type] || 'GEN';
  }

  public formatBibtexCreatorList(list?: CslName[]): string {
    if (!Array.isArray(list) || list.length === 0) return '';
    return list
      .map((c) => {
        if (c.literal && !c.family && !c.given) {
          return `{${c.literal.trim()}}`;
        }
        return `${c.family || c.literal || ''}, ${c.given || ''}`
          .replace(/,\s*$/, '')
          .trim();
      })
      .filter(Boolean)
      .join(' and ');
  }

  public formatIsoDateFromCsl(dateObj?: {
    'date-parts'?: Array<Array<number | string>>;
  }): string | undefined {
    const parts = dateObj?.['date-parts']?.[0];
    if (!Array.isArray(parts) || !parts[0]) return undefined;
    const y = String(parts[0]).padStart(4, '0');
    if (parts[1]) {
      const m = String(parts[1]).padStart(2, '0');
      if (parts[2]) {
        const d = String(parts[2]).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      return `${y}-${m}`;
    }
    return y;
  }

  public collectBibtexSupplementPairs(
    cslItem: CslItemData,
    targetType: string,
  ): Array<[string, string | number]> {
    const pairs: Array<[string, string | number]> = [];
    const pushIf = (key: string, val: unknown) => {
      if (typeof val === 'number' && Number.isFinite(val)) {
        pairs.push([key, val]);
      } else if (typeof val === 'string' && val.trim() !== '') {
        pairs.push([key, val]);
      }
    };

    if (cslItem.page) {
      pushIf(
        'pages',
        String(cslItem.page).replace(
          /^([A-Za-z0-9]+)\s*[-–—]+\s*([A-Za-z0-9]+)$/,
          '$1--$2',
        ),
      );
    }
    if (cslItem.publisher) {
      if (targetType === 'phdthesis' || targetType === 'mastersthesis') {
        pushIf('school', cslItem.publisher);
      } else if (targetType === 'techreport' || targetType === 'standard') {
        pushIf('institution', cslItem.publisher);
      } else {
        pushIf('publisher', cslItem.publisher);
      }
    }
    if (
      (targetType === 'incollection' || targetType === 'inproceedings') &&
      cslItem['container-title']
    ) {
      pushIf('booktitle', cslItem['container-title']);
    }
    if (Array.isArray(cslItem.editor) && cslItem.editor.length > 0) {
      pushIf('editor', this.formatBibtexCreatorList(cslItem.editor));
    }
    pushIf('series', cslItem['collection-title']);
    pushIf('edition', cslItem.edition);
    pushIf('address', cslItem['publisher-place']);
    const numberVal =
      targetType === 'article' || cslItem.type === 'article-journal'
        ? (cslItem.issue ?? cslItem.number)
        : (cslItem.number ?? cslItem.issue);
    pushIf('number', numberVal);
    pushIf('type', cslItem.genre);
    pushIf('version', cslItem.version);
    pushIf('isbn', cslItem.ISBN);
    pushIf('issn', cslItem.ISSN);
    pushIf('doi', cslItem.DOI);
    pushIf('pmid', cslItem.PMID);
    pushIf('pmcid', cslItem.PMCID);
    pushIf('url', cslItem.URL);
    pushIf('urldate', this.formatIsoDateFromCsl(cslItem.accessed));
    pushIf('abstract', cslItem.abstract);
    pushIf('language', cslItem.language);
    if (Array.isArray(cslItem._keywords) && cslItem._keywords.length > 0) {
      pushIf('keywords', cslItem._keywords.join(', '));
    } else if (cslItem.keyword) {
      pushIf('keywords', cslItem.keyword);
    }
    pushIf('annote', cslItem.annote);

    const arxivId =
      typeof cslItem._arxivId === 'string' && cslItem._arxivId
        ? cslItem._arxivId
        : typeof cslItem.note === 'string'
          ? cslItem.note.match(/arxiv:\s*(\S+)/i)?.[1]
          : undefined;
    if (arxivId) {
      pushIf('eprint', arxivId);
      pushIf('archiveprefix', 'arXiv');
      const primaryClass = (cslItem as Record<string, unknown>)
        ._arxivPrimaryClass;
      if (typeof primaryClass === 'string' && primaryClass.trim()) {
        pushIf('primaryclass', primaryClass.trim());
      }
    }

    return pairs;
  }

  public collectRisSupplementTags(
    cslItem: CslItemData,
  ): Array<{ tag: string; checkRegex: RegExp; value: string }> {
    const entries: Array<{ tag: string; checkRegex: RegExp; value: string }> =
      [];
    const pushTag = (tag: string, val: unknown, customCheck?: RegExp) => {
      if (typeof val === 'string' || typeof val === 'number') {
        const strVal = String(val).replace(/\r?\n+/g, ' ').trim();
        if (strVal !== '') {
          entries.push({
            tag,
            checkRegex: customCheck || new RegExp(`^${tag}\\s+-`, 'm'),
            value: strVal,
          });
        }
      }
    };

    if (Array.isArray(cslItem.editor)) {
      for (const ed of cslItem.editor) {
        const edStr =
          ed.literal && !ed.family && !ed.given
            ? ed.literal.trim()
            : `${ed.family || ed.literal || ''}, ${ed.given || ''}`
                .replace(/,\s*$/, '')
                .trim();
        if (edStr) pushTag('ED', edStr);
      }
    }

    pushTag('T2', cslItem['container-title'], /^(?:T2|JO|JF|BT)\s+-/m);
    pushTag('T3', cslItem['collection-title']);
    pushTag('J2', cslItem['container-title-short']);
    pushTag('ST', cslItem['title-short']);
    pushTag('ET', cslItem.edition);
    pushTag('VL', cslItem.volume);
    pushTag('IS', cslItem.issue ?? cslItem.number);

    if (cslItem.page) {
      const pageMatch = String(cslItem.page)
        .trim()
        .match(/^(\S+?)\s*[-–—]\s*(\S+)$/);
      if (pageMatch) {
        pushTag('SP', pageMatch[1]);
        pushTag('EP', pageMatch[2]);
      } else {
        pushTag('SP', cslItem.page);
      }
    }

    pushTag('DO', cslItem.DOI);
    pushTag('AN', cslItem.PMID, /(?:PMID:|^AN\s+-)/im);
    pushTag('C2', cslItem.PMCID);
    pushTag('PB', cslItem.publisher);
    pushTag('CY', cslItem['publisher-place']);
    pushTag('SN', cslItem.ISBN || cslItem.ISSN);
    pushTag('M3', cslItem.genre);
    pushTag('UR', cslItem.URL);
    pushTag('Y2', this.formatIsoDateFromCsl(cslItem.accessed));

    if (Array.isArray(cslItem._keywords)) {
      for (const kw of cslItem._keywords) {
        if (typeof kw === 'string' && kw.trim()) {
          pushTag(
            'KW',
            kw.trim(),
            new RegExp(
              `^KW\\s+-\\s+${kw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
              'm',
            ),
          );
        }
      }
    }
    const annoteStr =
      typeof cslItem.annote === 'string' ? cslItem.annote.trim() : '';
    if (annoteStr) {
      const annoteFirstLine = annoteStr
        .split(/\r?\n/)[0]
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pushTag(
        'N1',
        annoteStr,
        new RegExp(`^N1\\s+-\\s+${annoteFirstLine}`, 'm'),
      );
    }
    const noteStr = typeof cslItem.note === 'string' ? cslItem.note.trim() : '';
    if (noteStr && noteStr !== annoteStr) {
      const noteFirstLine = noteStr
        .split(/\r?\n/)[0]
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pushTag('N1', noteStr, new RegExp(`^N1\\s+-\\s+${noteFirstLine}`, 'm'));
    }
    const arxivId =
      typeof cslItem._arxivId === 'string' ? cslItem._arxivId.trim() : '';
    if (arxivId) {
      pushTag(
        'N1',
        `arXiv:${arxivId}`,
        new RegExp(
          `^N1\\s+-\\s+arXiv:${arxivId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          'm',
        ),
      );
    }
    pushTag('AB', cslItem.abstract);

    return entries;
  }

  public fallbackBibtex(item: CslItemData): string {
    const key = this.sanitizeBibtexKey(item.id || `ref_${Date.now()}`);
    const authors = this.formatBibtexCreatorList(item.author);
    const entryType = this.resolveBibtexEntryType(item);
    const escapedTitle = this.escapeBibtexValue(
      (item.title || '')
        .replace(/&/g, '\\&')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .replace(/#/g, '\\#'),
    );

    const lines = [`@${entryType}{${key},`, `  title = {${escapedTitle}},`];
    if (authors) lines.push(`  author = {${this.escapeBibtexValue(authors)}},`);
    if (entryType === 'article' && item['container-title']) {
      lines.push(
        `  journal = {${this.escapeBibtexValue(item['container-title'])}},`,
      );
    }
    const year = item.issued?.['date-parts']?.[0]?.[0];
    if (year) lines.push(`  year = {${this.escapeBibtexValue(year)}},`);
    if (item.volume)
      lines.push(`  volume = {${this.escapeBibtexValue(item.volume)}},`);

    for (const [fieldKey, val] of this.collectBibtexSupplementPairs(
      item,
      entryType,
    )) {
      lines.push(`  ${fieldKey} = {${this.escapeBibtexValue(val, fieldKey)}},`);
    }
    lines.push('}');
    return lines.join('\n');
  }

  public fallbackRis(item: CslItemData): string {
    const risType = this.resolveRisType(item);
    const cleanTitle = String(item.title || '')
      .replace(/\r?\n+/g, ' ')
      .trim();
    const lines = [`TY  - ${risType}`, `TI  - ${cleanTitle}`];
    for (const a of item.author || []) {
      const cleanAuthor = `${a.family || a.literal || ''}, ${a.given || ''}`
        .replace(/\r?\n+/g, ' ')
        .replace(/,\s*$/, '')
        .trim();
      lines.push(`AU  - ${cleanAuthor}`);
    }
    const year = item.issued?.['date-parts']?.[0]?.[0];
    if (year)
      lines.push(`PY  - ${String(year).replace(/\r?\n+/g, ' ').trim()}`);

    for (const { tag, value } of this.collectRisSupplementTags(item)) {
      lines.push(`${tag}  - ${String(value).replace(/\r?\n+/g, ' ').trim()}`);
    }
    lines.push('ER  - ');
    return lines.join('\n');
  }
}
