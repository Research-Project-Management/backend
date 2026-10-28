/**
 * citations/domain/crossref-arxiv.resolver.ts
 * Resolver resolving DOI, arXiv, and ISBN identifiers via public academic APIs
 * (CrossRef Content Negotiation, arXiv Atom Export API, and OpenLibrary Books API).
 */

import { IIdentifierResolverPort } from './citations.ports';
import { AcademicIdentifierVo } from './academic-identifier.vo';
import { BibEntry } from './bib-entry.entity';
import { RegexAstBibtexParser } from './regex-ast-bibtex.parser';
import { sanitizeCitationKey } from './bibtex.formatter';

interface CrossrefDateParts {
  'date-parts'?: number[][];
}

interface CrossrefAuthor {
  family?: string;
  given?: string;
  name?: string;
}

interface CrossrefItem {
  title?: string[];
  'published-print'?: CrossrefDateParts;
  'published-online'?: CrossrefDateParts;
  issued?: CrossrefDateParts;
  published?: CrossrefDateParts;
  author?: CrossrefAuthor[];
  editor?: CrossrefAuthor[];
  'container-title'?: string[];
  type?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string | number;
  publisher?: string;
  'publisher-location'?: string;
  ISSN?: string[];
  ISBN?: string[];
  URL?: string;
}

interface CrossrefResponse {
  message?: CrossrefItem;
}

/** CrossRef work type -> BibTeX entry type + container field. */
const CROSSREF_TYPE_MAP: Record<string, { type: string; container?: string }> =
  {
    'journal-article': { type: 'article', container: 'journal' },
    'proceedings-article': { type: 'inproceedings', container: 'booktitle' },
    'book-chapter': { type: 'incollection', container: 'booktitle' },
    'book-part': { type: 'incollection', container: 'booktitle' },
    'book-section': { type: 'incollection', container: 'booktitle' },
    book: { type: 'book' },
    monograph: { type: 'book' },
    'edited-book': { type: 'book' },
    'reference-book': { type: 'book' },
    report: { type: 'techreport' },
    dissertation: { type: 'phdthesis' },
    'posted-content': { type: 'misc', container: 'howpublished' },
  };

export type FetchLikeFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Decorator Pattern: Wraps a fetch implementation with timeout and transient 5xx retry.
 */
export function createResilientFetch(
  baseFetch: FetchLikeFn = (url, init) => fetch(url, init),
  options: { timeoutMs?: number; maxRetries?: number } = {},
): FetchLikeFn {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRetries = options.maxRetries ?? 1;

  return async (url: string, init?: RequestInit): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const timeoutSignal =
          typeof AbortSignal !== 'undefined' &&
          typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined;
        const mergedInit: RequestInit = {
          ...init,
          ...(timeoutSignal && !init?.signal ? { signal: timeoutSignal } : {}),
        };
        const response = await baseFetch(url, mergedInit);
        if (
          response.status >= 500 &&
          response.status < 600 &&
          attempt < maxRetries
        ) {
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt >= maxRetries) {
          throw err;
        }
      }
    }
    throw lastError;
  };
}

/**
 * Chain of Responsibility Pattern: Academic Identifier Resolution Handler
 */
export interface IIdentifierResolutionHandler {
  readonly name: string;
  setNext(handler: IIdentifierResolutionHandler): IIdentifierResolutionHandler;
  handle(identifier: AcademicIdentifierVo): Promise<BibEntry | null>;
}

export abstract class BaseIdentifierResolutionHandler
  implements IIdentifierResolutionHandler
{
  public abstract readonly name: string;
  private nextHandler?: IIdentifierResolutionHandler;

  public setNext(
    handler: IIdentifierResolutionHandler,
  ): IIdentifierResolutionHandler {
    this.nextHandler = handler;
    return handler;
  }

  public async handle(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    if (this.canHandle(identifier)) {
      const resolved = await this.tryResolve(identifier);
      if (resolved) {
        return resolved;
      }
    }
    if (this.nextHandler) {
      return this.nextHandler.handle(identifier);
    }
    return null;
  }

  protected abstract canHandle(identifier: AcademicIdentifierVo): boolean;
  protected abstract tryResolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null>;
}

/**
 * Builds a citation key "<family><year><firstTitleWord>" restricted to
 * [A-Za-z0-9_:.-]; falls back to a sanitized identifier-based key.
 */
export function buildResolvedCitationKey(
  family: string | undefined,
  year: string | undefined,
  title: string,
  fallback: string,
): string {
  const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and']);
  const firstWord =
    title
      .split(/\s+/)
      .map((w) => sanitizeCitationKey(w).replace(/[:.-]/g, '').toLowerCase())
      .find((w) => w.length > 0 && !STOP.has(w)) || '';
  const fam = sanitizeCitationKey(family || '')
    .replace(/[:.-]/g, '')
    .toLowerCase();
  const key = `${fam}${year || ''}${firstWord}`;
  if (fam && key) return key;
  return sanitizeCitationKey(fallback.replace(/\//g, '_')) || 'ref';
}

export class CrossrefBibtexResolutionHandler extends BaseIdentifierResolutionHandler {
  public readonly name = 'CrossrefBibtexContentNegotiation';

  constructor(
    private readonly fetchFn: FetchLikeFn,
    private readonly parser = new RegexAstBibtexParser(),
  ) {
    super();
  }

  protected canHandle(identifier: AcademicIdentifierVo): boolean {
    return identifier.isDoi();
  }

  protected async tryResolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    const contactMailto = process.env.CROSSREF_MAILTO || 'support@flux.app';
    try {
      const res = await this.fetchFn(
        `https://doi.org/${encodeURIComponent(identifier.clean)}`,
        {
          headers: {
            Accept: 'application/x-bibtex; charset=utf-8',
            'User-Agent': `FluxManuscripts/1.0 (mailto:${contactMailto})`,
          },
        },
      );

      if (res.ok) {
        const bibText = await res.text();
        const entries = this.parser.parse(bibText);
        if (entries.length > 0 && entries[0]) {
          return entries[0];
        }
      }
    } catch {
      // Pass to next handler in chain
    }
    return null;
  }
}

export class CrossrefJsonResolutionHandler extends BaseIdentifierResolutionHandler {
  public readonly name = 'CrossrefRestJsonApi';

  constructor(private readonly fetchFn: FetchLikeFn) {
    super();
  }

  protected canHandle(identifier: AcademicIdentifierVo): boolean {
    return identifier.isDoi();
  }

  protected async tryResolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    const cleanDoi = identifier.clean;
    try {
      const jsonRes = await this.fetchFn(
        `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`,
        {
          headers: { 'User-Agent': 'FluxManuscripts/1.0' },
        },
      );

      if (jsonRes.ok) {
        const data = (await jsonRes.json()) as CrossrefResponse;
        const item = data.message;
        if (item) {
          const title = item.title?.[0] || 'Untitled Document';
          const yearRaw =
            item['published-print']?.['date-parts']?.[0]?.[0] ||
            item['published-online']?.['date-parts']?.[0]?.[0] ||
            item.issued?.['date-parts']?.[0]?.[0] ||
            item.published?.['date-parts']?.[0]?.[0];
          const year = yearRaw ? String(yearRaw) : undefined;

          const authors = (item.author || [])
            .map((a) => {
              if (a.family && a.given) return `${a.family}, ${a.given}`;
              if (a.family) return String(a.family);
              if (a.name) return `{${a.name}}`;
              return '';
            })
            .filter(Boolean)
            .join(' and ');
          const editors = (item.editor || [])
            .map((a) =>
              a.family && a.given
                ? `${a.family}, ${a.given}`
                : a.family || (a.name ? `{${a.name}}` : ''),
            )
            .filter(Boolean)
            .join(' and ');

          const containerTitle = item['container-title']?.[0];
          const mapping =
            (item.type && CROSSREF_TYPE_MAP[item.type]) ||
            (containerTitle
              ? { type: 'article', container: 'journal' }
              : { type: 'misc' });

          const fields: Record<string, string> = {
            title,
            author: authors || 'Unknown Author',
            doi: cleanDoi,
          };
          if (editors) fields.editor = editors;
          if (year) fields.year = year;
          if (mapping.container && containerTitle) {
            fields[mapping.container] = containerTitle;
          }
          if (item.volume) fields.volume = String(item.volume);
          if (item.issue) fields.number = String(item.issue);
          if (item.page) {
            fields.pages = String(item.page).replace(
              /\s*[-\u2010-\u2015]+\s*/g,
              '--',
            );
          }
          if (item.publisher) {
            if (mapping.type === 'techreport')
              fields.institution = item.publisher;
            else if (mapping.type === 'phdthesis')
              fields.school = item.publisher;
            else if (mapping.type !== 'article')
              fields.publisher = item.publisher;
          }
          if (item['publisher-location']) {
            fields.address = String(item['publisher-location']);
          }
          if (Array.isArray(item.ISSN) && item.ISSN[0])
            fields.issn = item.ISSN[0];
          if (Array.isArray(item.ISBN) && item.ISBN[0])
            fields.isbn = item.ISBN[0];
          if (item.URL) fields.url = String(item.URL);

          return new BibEntry({
            key: buildResolvedCitationKey(
              item.author?.[0]?.family || item.author?.[0]?.name,
              year,
              title,
              `doi_${cleanDoi}`,
            ),
            entryType: mapping.type,
            fields,
            valueFormat: 'plain',
          });
        }
      }
    } catch {
      // Pass to next handler in chain
    }
    return null;
  }
}

export class ArxivAtomResolutionHandler extends BaseIdentifierResolutionHandler {
  public readonly name = 'ArxivAtomExportApi';

  constructor(private readonly fetchFn: FetchLikeFn) {
    super();
  }

  protected canHandle(identifier: AcademicIdentifierVo): boolean {
    return identifier.isArxiv();
  }

  protected async tryResolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    const cleanArxivId = identifier.clean;
    try {
      const res = await this.fetchFn(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanArxivId)}`,
      );

      if (res.ok) {
        const xmlText = await res.text();
        const entryMatch = xmlText.match(/<entry>([\s\S]*?)<\/entry>/i);
        if (entryMatch && entryMatch[1]) {
          const entryXml = entryMatch[1];

          const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/i);
          const title = titleMatch
            ? decodeXmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim())
            : 'arXiv Preprint';

          const publishedMatch = entryXml.match(/<published>(\d{4})/i);
          const year = publishedMatch ? publishedMatch[1] : undefined;

          const rawAuthors: string[] = [];
          const authorRegex = /<author>\s*<name>([^<]+)<\/name>/gi;
          let aMatch: RegExpExecArray | null;
          while ((aMatch = authorRegex.exec(entryXml)) !== null) {
            if (aMatch[1]) rawAuthors.push(decodeXmlEntities(aMatch[1].trim()));
          }
          const authors = rawAuthors.map(toFamilyGiven);

          const primaryMatch = entryXml.match(
            /<arxiv:primary_category[^>]*\bterm="([^"]+)"/i,
          );
          const doiMatch = entryXml.match(
            /<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/i,
          );

          const fields: Record<string, string> = {
            title,
            author: authors.join(' and ') || 'Unknown Author',
            eprint: cleanArxivId,
            archiveprefix: 'arXiv',
            url: `https://arxiv.org/abs/${cleanArxivId}`,
          };
          if (year) fields.year = year;
          if (primaryMatch?.[1]) fields.primaryclass = primaryMatch[1];
          if (doiMatch?.[1]) fields.doi = doiMatch[1].trim();

          const firstFamily = authors[0]?.split(',')[0];
          return new BibEntry({
            key: buildResolvedCitationKey(
              firstFamily,
              year,
              title,
              `arxiv_${cleanArxivId}`,
            ),
            entryType: 'misc',
            fields,
            valueFormat: 'plain',
          });
        }
      }
    } catch {
      // Pass to next handler in chain
    }
    return null;
  }
}

export interface OpenLibraryBookItem {
  title?: string;
  publish_date?: string;
  authors?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
  publish_places?: Array<{ name?: string }>;
  number_of_pages?: number;
  url?: string;
}

export class OpenLibraryIsbnResolutionHandler extends BaseIdentifierResolutionHandler {
  public readonly name = 'OpenLibraryBooksApi';

  constructor(private readonly fetchFn: FetchLikeFn) {
    super();
  }

  protected canHandle(identifier: AcademicIdentifierVo): boolean {
    return identifier.isIsbn();
  }

  protected async tryResolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    const cleanIsbn = identifier.clean;
    try {
      const bibKey = `ISBN:${cleanIsbn}`;
      const res = await this.fetchFn(
        `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibKey)}&format=json&jscmd=data`,
        {
          headers: { 'User-Agent': 'FluxManuscripts/1.0' },
        },
      );

      if (res.ok) {
        const data = (await res.json()) as Record<string, OpenLibraryBookItem>;
        const book = data?.[bibKey];
        if (book) {
          const title = book.title?.trim() || 'Untitled Book';
          const yearMatch = book.publish_date?.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
          const year = yearMatch ? yearMatch[1] : undefined;
          const authors = (book.authors || [])
            .map((a) => (a.name ? toFamilyGiven(a.name.trim()) : ''))
            .filter(Boolean);
          const publisher = book.publishers?.[0]?.name?.trim();
          const address = book.publish_places?.[0]?.name?.trim();

          const fields: Record<string, string> = {
            title,
            author: authors.join(' and ') || 'Unknown Author',
            isbn: cleanIsbn,
          };
          if (year) fields.year = year;
          if (publisher) fields.publisher = publisher;
          if (address) fields.address = address;
          if (book.url) fields.url = book.url;

          const firstFamily = authors[0]?.split(',')[0];
          return new BibEntry({
            key: buildResolvedCitationKey(
              firstFamily,
              year,
              title,
              `isbn_${cleanIsbn}`,
            ),
            entryType: 'book',
            fields,
            valueFormat: 'plain',
          });
        }
      }
    } catch {
      // Pass to next handler in chain
    }
    return null;
  }
}

export class CrossrefArxivResolverAdapter implements IIdentifierResolverPort {
  private readonly headHandler: IIdentifierResolutionHandler;

  constructor(
    fetchFn: FetchLikeFn = createResilientFetch(),
    customChainHead?: IIdentifierResolutionHandler,
  ) {
    if (customChainHead) {
      this.headHandler = customChainHead;
    } else {
      const bibtexHandler = new CrossrefBibtexResolutionHandler(fetchFn);
      const jsonHandler = new CrossrefJsonResolutionHandler(fetchFn);
      const arxivHandler = new ArxivAtomResolutionHandler(fetchFn);
      const isbnHandler = new OpenLibraryIsbnResolutionHandler(fetchFn);
      bibtexHandler
        .setNext(jsonHandler)
        .setNext(arxivHandler)
        .setNext(isbnHandler);
      this.headHandler = bibtexHandler;
    }
  }

  public async resolve(
    identifier: AcademicIdentifierVo,
  ): Promise<BibEntry | null> {
    return this.headHandler.handle(identifier);
  }
}

/** "Ashish Vaswani" -> "Vaswani, Ashish"; keeps lowercase particles with the family name. */
function toFamilyGiven(name: string): string {
  if (name.includes(',')) return name;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  // First lowercase token after the first word starts the family part (von/van der/de la ...)
  let idx = parts.findIndex((p, i) => i > 0 && /^\p{Ll}/u.test(p));
  if (idx === -1) idx = parts.length - 1;
  const given = parts.slice(0, idx).join(' ');
  const family = parts.slice(idx).join(' ');
  return given ? `${family}, ${given}` : family;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, '&');
}
