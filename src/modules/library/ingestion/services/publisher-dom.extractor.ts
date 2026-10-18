import { Injectable } from '@nestjs/common';
import {
  decodeHtmlEntities,
  normalizeDoi,
  parseCreatorString,
} from '@/modules/library/core';

/** Partial metadata from a structured fallback source (JSON-LD / COinS). */
export type FallbackMeta = {
  title?: string;
  authors?: string[];
  creators?: Array<{
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType?: string;
    fieldMode?: number;
  }>;
  date?: string;
  publicationTitle?: string;
  publisher?: string;
  doi?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  abstract?: string;
  keywords?: string[];
  language?: string;
  itemType?: string;
};

/** JSON-LD @type values considered bibliographic, in priority order. */
export const JSONLD_TYPES = [
  'ScholarlyArticle',
  'MedicalScholarlyArticle',
  'Chapter',
  'Thesis',
  'Report',
  'Book',
  'Dataset',
  'Article',
  'NewsArticle',
  'BlogPosting',
];

export const JSONLD_TYPE_TO_ITEM_TYPE: Record<string, string | undefined> = {
  ScholarlyArticle: 'journalArticle',
  MedicalScholarlyArticle: 'journalArticle',
  Chapter: 'bookSection',
  Thesis: 'thesis',
  Report: 'report',
  Book: 'book',
  Dataset: 'dataset',
  NewsArticle: 'newspaperArticle',
  BlogPosting: 'blogPost',
  Article: undefined,
};

@Injectable()
export class PublisherDomExtractor {
  /**
   * Extracts a readable title and filename hint from the URL pathname slug.
   */
  extractSlugMetadata(rawUrl: string): { title?: string; filename: string } {
    try {
      const parsed = new URL(rawUrl);
      const pathname = parsed.pathname;
      const lastSeg = pathname.split('/').filter(Boolean).pop() || '';
      const rawFilename = decodeURIComponent(lastSeg) || 'document.pdf';

      const isPdf =
        pathname.toLowerCase().endsWith('.pdf') ||
        rawFilename.toLowerCase().endsWith('.pdf') ||
        pathname.toLowerCase().includes('/pdf/');

      const filename = isPdf
        ? rawFilename.toLowerCase().endsWith('.pdf')
          ? rawFilename
          : `${rawFilename}.pdf`
        : rawFilename;

      const slugWithoutExt = rawFilename
        .replace(/\.(pdf|html?|php|aspx?)$/i, '')
        .trim();

      let cleanSlug = slugWithoutExt.replace(
        /^(\d{4,8}[-_]|v\d+[-_]|[0-9a-f]{16,}[-_])+/i,
        '',
      );
      cleanSlug = cleanSlug.replace(/[-_](abstract|paper|supplemental)$/i, '');

      const words = cleanSlug
        .split(/[-_+.\s]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      const genericWords = new Set([
        'download',
        'document',
        'paper',
        'file',
        'view',
        'viewcontent',
        'content',
        'pdf',
        'main',
        'fulltext',
        'article',
      ]);

      const meaningfulWords = words.filter(
        (w) =>
          !genericWords.has(w.toLowerCase()) &&
          /^[A-Za-z\u00C0-\u024F]{3,}$/.test(w),
      );

      let title: string | undefined;
      if (meaningfulWords.length >= 2) {
        const rawTitle = words.join(' ');
        title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
      }

      return { title, filename };
    } catch {
      return { filename: 'document.pdf' };
    }
  }

  cleanPublisherTitle(rawTitle: string): string {
    return rawTitle
      .replace(
        /\s*(\||—|-)\s*(NeurIPS|CVPR|ICCV|ECCV|ICLR|ICML|AAAI|ACL|ScienceDirect|SpringerLink|Nature|IEEE\s*Xplore|arXiv|ACM\s*Digital\s*Library|PubMed|Wiley\s*Online\s*Library|PLOS|Frontiers|ResearchGate|Semantic\s*Scholar|OpenReview).*$/i,
        '',
      )
      .trim();
  }

  joinPages(first?: string, last?: string): string | undefined {
    if (first && last && first !== last) return `${first}-${last}`;
    return first || last || undefined;
  }

  toCreator(
    rawName: string,
    orderIndex: number,
    creatorType = 'author',
  ): {
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType: string;
    fieldMode?: number;
  } {
    const parsed = parseCreatorString(rawName, orderIndex, creatorType);
    return {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      fullName: parsed.fullName,
      creatorType: parsed.creatorType,
      fieldMode: parsed.fieldMode === 1 ? 1 : undefined,
    };
  }

  parseAttributes(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag)) !== null) {
      const name = m[1].toLowerCase();
      const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      attrs[name] = decodeHtmlEntities(val);
    }
    return attrs;
  }

  extractJsonLdMetadata(html: string): FallbackMeta {
    const out: FallbackMeta = {};
    const nodes: Array<Record<string, unknown>> = [];
    const scriptRe =
      /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(html)) !== null) {
      const raw = m[1]
        .trim()
        .replace(/^<!--|-->$/g, '')
        .trim();
      if (!raw) continue;
      try {
        this.flattenJsonLd(JSON.parse(raw), nodes, 0);
      } catch {
        /* malformed JSON-LD — ignore */
      }
    }
    if (nodes.length === 0) return out;

    const typesOf = (n: unknown): string[] => {
      const nObj =
        typeof n === 'object' && n !== null
          ? (n as Record<string, unknown>)
          : null;
      const typeVal = nObj?.['@type'];
      return (Array.isArray(typeVal) ? typeVal : [typeVal])
        .filter((t: unknown): t is string => typeof t === 'string')
        .map((t: string) => t.replace(/^.*[/#:]/, ''));
    };

    let node: Record<string, unknown> | undefined;
    let nodeType: string | undefined;
    for (const t of JSONLD_TYPES) {
      node = nodes.find((n) => typesOf(n).includes(t));
      if (node) {
        nodeType = t;
        break;
      }
    }
    if (!node || !nodeType) return out;

    const str = (v: unknown): string | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'string' || typeof v === 'number') {
        const s = decodeHtmlEntities(String(v)).trim();
        return s || undefined;
      }
      if (Array.isArray(v)) return str(v[0]);
      if (typeof v === 'object' && v !== null) {
        const vObj = v as Record<string, unknown>;
        return str(vObj.name ?? vObj['@value'] ?? vObj.value);
      }
      return undefined;
    };
    const arr = (v: unknown): unknown[] =>
      v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

    out.itemType = JSONLD_TYPE_TO_ITEM_TYPE[nodeType];
    out.title = str(node.headline) || str(node.name);

    const authors: string[] = [];
    const creators: NonNullable<FallbackMeta['creators']> = [];
    for (const a of arr(node.author ?? node.creator)) {
      if (typeof a === 'string') {
        const s = str(a);
        if (s) {
          authors.push(s);
          creators.push(this.toCreator(s, creators.length, 'author'));
        }
      } else if (a && typeof a === 'object') {
        const aObj = a as Record<string, unknown>;
        const aTypes = typesOf(aObj).map((t) => t.toLowerCase());
        const isOrg = aTypes.some(
          (t) =>
            t.includes('organization') ||
            t.includes('corporation') ||
            t.includes('consortium') ||
            t.includes('college') ||
            t.includes('university'),
        );
        const given = str(aObj.givenName);
        const family = str(aObj.familyName);
        const name =
          given || family
            ? [given, family].filter(Boolean).join(' ')
            : str(aObj.name);
        if (name) {
          authors.push(name);
          if (isOrg && !given && !family) {
            creators.push({
              firstName: '',
              lastName: name,
              fullName: name,
              creatorType: 'author',
              fieldMode: 1,
            });
          } else if (given || family) {
            creators.push({
              firstName: given || '',
              lastName: family || name,
              fullName: name,
              creatorType: 'author',
            });
          } else {
            creators.push(this.toCreator(name, creators.length, 'author'));
          }
        }
      }
    }
    if (authors.length) out.authors = authors;
    if (creators.length) out.creators = creators;

    out.date = str(node.datePublished) || str(node.dateCreated);
    out.abstract = str(node.description) || str(node.abstract);
    out.volume = str(node.volumeNumber);
    out.issue = str(node.issueNumber);
    out.pages =
      str(node.pagination) ||
      this.joinPages(str(node.pageStart), str(node.pageEnd));
    out.isbn = str(node.isbn);
    out.issn = str(node.issn);
    out.language = str(node.inLanguage);

    const kw = node.keywords;
    if (typeof kw === 'string') {
      out.keywords = kw
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean);
    } else if (Array.isArray(kw)) {
      out.keywords = kw.map((k) => str(k)).filter((k): k is string => !!k);
    }

    let container = arr(node.isPartOf)[0];
    for (let depth = 0; container && depth < 4; depth++) {
      if (typeof container === 'string') {
        out.publicationTitle = out.publicationTitle || str(container);
        break;
      }
      const cObj =
        typeof container === 'object' && container !== null
          ? (container as Record<string, unknown>)
          : {};
      const ctypes = typesOf(container);
      if (ctypes.includes('PublicationIssue')) {
        out.issue = out.issue || str(cObj.issueNumber);
      } else if (ctypes.includes('PublicationVolume')) {
        out.volume = out.volume || str(cObj.volumeNumber);
      } else {
        out.publicationTitle = out.publicationTitle || str(cObj.name);
      }
      out.issn = out.issn || str(cObj.issn);
      out.isbn = out.isbn || str(cObj.isbn);
      container = arr(cObj.isPartOf)[0];
    }

    out.publisher = str(node.publisher);

    const idCandidates: string[] = [];
    for (const id of arr(node.identifier)) {
      if (typeof id === 'string') idCandidates.push(id);
      else if (id && typeof id === 'object') {
        const idObj = id as Record<string, unknown>;
        const prop = (str(idObj.propertyID) || '').toLowerCase();
        const val = str(idObj.value ?? idObj['@id']);
        if (val && (!prop || prop === 'doi' || /10\.\d{4,9}\//.test(val))) {
          idCandidates.push(val);
        }
      }
    }
    for (const s of arr(node.sameAs))
      if (typeof s === 'string') idCandidates.push(s);
    if (typeof node['@id'] === 'string') idCandidates.push(node['@id']);
    for (const c of idCandidates) {
      if (!/10\.\d{4,9}\//.test(c)) continue;
      const d = normalizeDoi(c);
      if (d) {
        out.doi = d;
        break;
      }
    }

    return out;
  }

  flattenJsonLd(
    value: unknown,
    acc: Array<Record<string, unknown>>,
    depth: number,
  ): void {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) this.flattenJsonLd(v, acc, depth + 1);
      return;
    }
    const valObj = value as Record<string, unknown>;
    if (valObj['@type']) acc.push(valObj);
    if (Array.isArray(valObj['@graph'])) {
      this.flattenJsonLd(valObj['@graph'], acc, depth + 1);
    }
    if (valObj.mainEntity && typeof valObj.mainEntity === 'object') {
      this.flattenJsonLd(valObj.mainEntity, acc, depth + 1);
    }
  }

  extractCoinsMetadata(html: string): FallbackMeta {
    const out: FallbackMeta = {};
    const spanRe = /<span\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
    let m: RegExpExecArray | null;
    let ctx: string | undefined;
    while ((m = spanRe.exec(html)) !== null) {
      const attrs = this.parseAttributes(m[1]);
      if (!/\bZ3988\b/.test(attrs['class'] || '')) continue;
      if (attrs['title']) {
        ctx = attrs['title'];
        break;
      }
    }
    if (!ctx) return out;

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(decodeHtmlEntities(ctx));
    } catch {
      return out;
    }
    const get = (k: string): string | undefined => {
      const v = params.get(k);
      return v && v.trim() ? v.trim() : undefined;
    };

    out.title = get('rft.atitle') || get('rft.title') || get('rft.btitle');

    const authors = params
      .getAll('rft.au')
      .map((a) => a.trim())
      .filter(Boolean);
    if (authors.length === 0) {
      const last = get('rft.aulast');
      const firstName = get('rft.aufirst');
      if (last) authors.push(firstName ? `${firstName} ${last}` : last);
    }
    if (authors.length) out.authors = authors;

    out.date = get('rft.date');
    out.publicationTitle =
      get('rft.jtitle') || (get('rft.atitle') ? get('rft.btitle') : undefined);
    out.volume = get('rft.volume');
    out.issue = get('rft.issue');
    out.pages =
      this.joinPages(get('rft.spage'), get('rft.epage')) || get('rft.pages');
    out.issn = get('rft.issn') || get('rft.eissn');
    out.isbn = get('rft.isbn');
    out.publisher = get('rft.pub');

    for (const id of params.getAll('rft_id')) {
      if (/^info:doi\//i.test(id) || /doi\.org\//i.test(id)) {
        const d = normalizeDoi(id.replace(/^info:doi\//i, ''));
        if (d) {
          out.doi = d;
          break;
        }
      }
    }

    const genre = (get('rft.genre') || '').toLowerCase();
    const fmt = (get('rft_val_fmt') || '').toLowerCase();
    if (fmt.includes('dissertation')) out.itemType = 'thesis';
    else if (genre === 'proceeding' || genre === 'conference')
      out.itemType = 'conferencePaper';
    else if (genre === 'bookitem') out.itemType = 'bookSection';
    else if (genre === 'book') out.itemType = 'book';
    else if (genre === 'report') out.itemType = 'report';
    else if (genre === 'article' || fmt.includes('journal'))
      out.itemType = 'journalArticle';

    return out;
  }
}
