import {
  cleanAbstractText,
  cleanBibliographicText,
  decodeHtmlEntities,
  normalizeArxivId,
  normalizeDoi,
  normalizeTags,
} from '@/modules/library/ingestion/domain/metadata.domain';
import { parseCreatorString } from '@/modules/library/shared-kernel/domain/bibliographic.domain';
import { AcademicCreator } from '@/modules/library/shared-kernel/types/bibliographic.types';

export type FeedFormat = 'rss2' | 'rss1-rdf' | 'atom';

export interface ParsedFeedEntry {
  id: string;
  title: string;
  url?: string;
  pdfUrl?: string;
  doi?: string;
  arxivId?: string;
  primaryCategory?: string;
  authors: string[];
  creators: AcademicCreator[];
  abstract?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publicationDate?: string;
  year?: number | null;
  keywords: string[];
  rights?: string;
  itemType: 'journalArticle' | 'preprint' | 'webpage';
}

export interface ParsedAcademicFeed {
  format: FeedFormat;
  feedTitle?: string;
  feedUrl?: string;
  updatedAt?: string;
  entries: ParsedFeedEntry[];
}

export interface PromoteFeedEntryOptions {
  projectId?: string;
  collectionId?: string;
  tags?: string[];
  attachPdfUrl?: boolean;
}

export interface FeedPromotionCatalogPort {
  findExistingByIdentifier?(
    userId: string,
    params: {
      doi?: string;
      arxivId?: string;
      url?: string;
      projectId?: string;
    },
  ): Promise<{ id: string; title: string; isDuplicate?: boolean } | null>;
  createItem(
    userId: string,
    data: {
      title: string;
      itemType: string;
      authors: string[];
      creators?: AcademicCreator[];
      year?: number;
      doi?: string;
      url?: string;
      abstract?: string;
      publicationTitle?: string;
      projectId?: string;
      collectionIds?: string[];
      tags?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string; title: string; projectId?: string | null }>;
}

export interface PromoteFeedEntryResult {
  item: { id: string; title: string; projectId?: string | null };
  deduplicated: boolean;
  feedEntryId: string;
}

/**
 * Strips XML CDATA wrappers (`<![CDATA[...]]>`) and HTML tags while preserving readable text.
 */
function stripCdataAndHtml(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  text = decodeHtmlEntities(text);
  // Strip script/style blocks completely
  text = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  // Replace block-level HTML tags with spaces/newlines before stripping all tags
  text = text
    .replace(/<\/?(?:p|div|br|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts text inside the first matching XML tag (namespace-aware or plain).
 */
function extractTagValue(
  xml: string,
  tagPatterns: string[],
): string | undefined {
  for (const pattern of tagPatterns) {
    const regex = new RegExp(
      `<${pattern}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${pattern}>`,
      'i',
    );
    const match = xml.match(regex);
    if (match?.[1]) {
      const cleaned = stripCdataAndHtml(match[1]);
      if (cleaned) return cleaned;
    }
  }
  return undefined;
}

/**
 * Extracts all occurrences of matching XML tags.
 */
function extractAllTagValues(xml: string, tagPatterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of tagPatterns) {
    const regex = new RegExp(
      `<${pattern}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${pattern}>`,
      'gi',
    );
    for (const match of xml.matchAll(regex)) {
      if (match[1]) {
        const cleaned = stripCdataAndHtml(match[1]);
        if (cleaned) results.push(cleaned);
      }
    }
  }
  return results;
}

/**
 * Parses a publication date string (ISO 8601, RFC 2822, or YYYY-MM-DD) into
 * `{ publicationDate, year }`.
 */
function parseFeedDate(rawDate: string | undefined): {
  publicationDate?: string;
  year?: number | null;
} {
  if (!rawDate) return { year: null };
  const trimmed = rawDate.trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return {
      publicationDate: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`,
      year: Number.parseInt(isoMatch[1], 10),
    };
  }
  const yearOnlyMatch = trimmed.match(/^(\d{4})$/);
  if (yearOnlyMatch) {
    return {
      publicationDate: yearOnlyMatch[1],
      year: Number.parseInt(yearOnlyMatch[1], 10),
    };
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const d = String(parsed.getUTCDate()).padStart(2, '0');
    return {
      publicationDate: `${y}-${m}-${d}`,
      year: y,
    };
  }
  const fallbackYear = trimmed.match(/\b(19\d{2}|20\d{2})\b/);
  return {
    publicationDate: trimmed,
    year: fallbackYear ? Number.parseInt(fallbackYear[1], 10) : null,
  };
}

/**
 * Extracts DOI and/or arXiv ID from identifiers, links, and text fields.
 */
function resolveIdentifiers(params: {
  rawDoi?: string;
  rawId?: string;
  link?: string;
  dcIdentifiers: string[];
  description?: string;
}): { doi?: string; arxivId?: string } {
  let doi = params.rawDoi ? normalizeDoi(params.rawDoi) : undefined;
  let arxivId = params.rawId ? normalizeArxivId(params.rawId) : undefined;

  for (const idVal of params.dcIdentifiers) {
    if (!doi) {
      const candidateDoi = normalizeDoi(idVal);
      if (candidateDoi) doi = candidateDoi;
    }
    if (!arxivId) {
      const candidateArxiv = normalizeArxivId(idVal);
      if (candidateArxiv) arxivId = candidateArxiv;
    }
  }

  if (!arxivId && params.link) {
    arxivId = normalizeArxivId(params.link);
  }

  if (!doi && params.link) {
    const doiFromLink = normalizeDoi(params.link);
    if (doiFromLink) doi = doiFromLink;
  }

  if (!doi && params.description) {
    const doiInDesc = params.description.match(
      /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/,
    );
    if (doiInDesc?.[1]) {
      doi = normalizeDoi(doiInDesc[1]);
    }
  }

  if (!arxivId && params.description) {
    const arxivInDesc = params.description.match(
      /\barXiv:(\d{4}\.\d{4,5}(?:v\d+)?)\b/i,
    );
    if (arxivInDesc?.[1]) {
      arxivId = normalizeArxivId(arxivInDesc[1]);
    }
  } else if (arxivId && !/v\d+$/i.test(arxivId) && params.description) {
    const versionedInDesc = params.description.match(
      new RegExp(`\\barXiv:(${arxivId.replace('.', '\\.')}v\\d+)\\b`, 'i'),
    );
    if (versionedInDesc?.[1]) {
      arxivId = normalizeArxivId(versionedInDesc[1]);
    }
  }

  if (!doi && arxivId) {
    const canonicalArxiv = arxivId.replace(/v\d+$/i, '');
    doi = `10.48550/arXiv.${canonicalArxiv}`;
  }

  return { doi, arxivId };
}

/**
 * Normalizes creator strings (handles comma-separated, "and"-separated, or individual tags)
 */
function parseFeedAuthors(rawAuthors: string[]): {
  authors: string[];
  creators: AcademicCreator[];
} {
  const authors: string[] = [];
  const creators: AcademicCreator[] = [];
  const seen = new Set<string>();

  for (const raw of rawAuthors) {
    const cleaned = stripCdataAndHtml(raw);
    if (!cleaned) continue;

    // If a single tag contains multiple comma-separated names like "Alice Smith, Bob Jones"
    // (as opposed to "Smith, Alice" which has 1 comma and no 'and')
    const commaParts = cleaned
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const pieces =
      commaParts.length > 2 || /\band\b/i.test(cleaned)
        ? cleaned
            .split(/\s+and\s+|;\s*|\s*,\s*(?=[A-Z][a-z]+\s+[A-Z])/g)
            .map((s) => s.trim())
            .filter(Boolean)
        : [cleaned];

    for (const piece of pieces) {
      const key = piece.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const parsed = parseCreatorString(piece, creators.length, 'author');
      const display =
        parsed.fullName ||
        [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim() ||
        piece;
      authors.push(display);
      creators.push(parsed);
    }
  }

  return { authors, creators };
}

/**
 * Parses an Atom `<entry>`, RSS 2.0 `<item>`, or RDF/RSS 1.0 `<item>` block.
 */
function parseFeedEntryXml(
  entryXml: string,
  format: FeedFormat,
): ParsedFeedEntry | null {
  const rawTitle = extractTagValue(entryXml, ['title', 'dc:title']);
  if (!rawTitle || rawTitle.toLowerCase() === 'error') {
    return null;
  }
  const title =
    cleanBibliographicText(
      rawTitle.replace(/\s*\(arXiv:[^)]+\)\s*$/i, '').trim(),
    ) || rawTitle;

  // Links (Atom <link href="..."/> or RSS <link>...</link>)
  let url = extractTagValue(entryXml, ['link', 'prism:url']);
  let pdfUrl: string | undefined;

  const atomLinks = Array.from(entryXml.matchAll(/<link\b([^>]*)\/?>/gi));
  for (const linkMatch of atomLinks) {
    const attrs = linkMatch[1] || '';
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch?.[1]) continue;
    const href = decodeHtmlEntities(hrefMatch[1].trim());
    const relMatch = attrs.match(/\brel=["']([^"']+)["']/i);
    const typeMatch = attrs.match(/\btype=["']([^"']+)["']/i);
    const titleAttrMatch = attrs.match(/\btitle=["']([^"']+)["']/i);

    if (
      typeMatch?.[1]?.toLowerCase() === 'application/pdf' ||
      titleAttrMatch?.[1]?.toLowerCase() === 'pdf'
    ) {
      pdfUrl = href;
    } else if (!url || relMatch?.[1]?.toLowerCase() === 'alternate') {
      url = href;
    }
  }

  const rawId =
    extractTagValue(entryXml, ['id', 'guid']) ||
    entryXml.match(/<item[^>]*\brdf:about=["']([^"']+)["']/i)?.[1] ||
    url ||
    title;

  // Authors (<author><name>...</name></author>, <dc:creator>, <author>)
  const atomAuthorNames = Array.from(
    entryXml.matchAll(
      /<author>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi,
    ),
    (m) => m[1],
  );
  const dcCreators = extractAllTagValues(entryXml, ['dc:creator', 'creator']);
  const plainAuthors =
    atomAuthorNames.length === 0 && dcCreators.length === 0
      ? extractAllTagValues(entryXml, ['author'])
      : [];

  const { authors, creators } = parseFeedAuthors([
    ...atomAuthorNames,
    ...dcCreators,
    ...plainAuthors,
  ]);

  // Abstract / Summary / Description / content:encoded
  const rawAbstract = extractTagValue(entryXml, [
    'summary',
    'content:encoded',
    'description',
    'content',
    'dc:description',
  ]);
  const strippedAbstractPrefix = rawAbstract
    ? rawAbstract
        .replace(/^arXiv:\S+\s+Announce Type:\s*\S+\s*(?:Abstract:\s*)?/i, '')
        .replace(/^Abstract:\s*/i, '')
        .trim()
    : undefined;
  const cleanedAbstract = strippedAbstractPrefix
    ? cleanAbstractText(strippedAbstractPrefix) || strippedAbstractPrefix
    : undefined;

  // Identifiers (PRISM, arXiv, DC)
  const rawDoi = extractTagValue(entryXml, [
    'prism:doi',
    'arxiv:doi',
    'dc:doi',
  ]);
  const dcIdentifiers = extractAllTagValues(entryXml, ['dc:identifier']);
  const { doi, arxivId } = resolveIdentifiers({
    rawDoi,
    rawId,
    link: url,
    dcIdentifiers,
    description: rawAbstract,
  });

  if (!pdfUrl && arxivId) {
    const cleanArxiv = arxivId.replace(/v\d+$/i, '');
    pdfUrl = `https://arxiv.org/pdf/${cleanArxiv}.pdf`;
  }

  // Publication venue, volume, issue, pages
  const publicationTitle = extractTagValue(entryXml, [
    'prism:publicationName',
    'arxiv:journal_ref',
    'dc:source',
  ]);
  const volume = extractTagValue(entryXml, ['prism:volume']);
  const issue = extractTagValue(entryXml, ['prism:number', 'prism:issue']);
  const startingPage = extractTagValue(entryXml, ['prism:startingPage']);
  const endingPage = extractTagValue(entryXml, ['prism:endingPage']);
  const pages =
    startingPage && endingPage
      ? `${startingPage}-${endingPage}`
      : startingPage || extractTagValue(entryXml, ['prism:pageRange']);

  // Dates
  const rawDate = extractTagValue(entryXml, [
    'published',
    'prism:coverDate',
    'prism:publicationDate',
    'dc:date',
    'pubDate',
    'updated',
  ]);
  const { publicationDate, year } = parseFeedDate(rawDate);

  // Categories / Keywords
  const atomCategories = Array.from(
    entryXml.matchAll(/<category[^>]*\bterm=["']([^"']+)["'][^>]*>/gi),
    (m) => decodeHtmlEntities(m[1].trim()),
  );
  const rssCategories = extractAllTagValues(entryXml, [
    'category',
    'dc:subject',
  ]);
  const primaryCatMatch = entryXml.match(
    /<arxiv:primary_category[^>]*\bterm=["']([^"']+)["'][^>]*>/i,
  );
  const primaryCategory = primaryCatMatch?.[1]
    ? decodeHtmlEntities(primaryCatMatch[1].trim())
    : atomCategories[0] || rssCategories[0];

  const keywords = normalizeTags([
    ...atomCategories,
    ...rssCategories,
    ...(primaryCategory ? [primaryCategory] : []),
  ]);

  // Rights / License
  let rights = extractTagValue(entryXml, [
    'rights',
    'dc:rights',
    'prism:copyright',
  ]);
  if (!rights) {
    const licenseLink =
      entryXml.match(
        /<link[^>]*title=["']license["'][^>]*href=["']([^"']+)["'][^>]*>/i,
      )?.[1] ||
      entryXml.match(
        /<link[^>]*href=["']([^"']+)["'][^>]*title=["']license["'][^>]*>/i,
      )?.[1];
    if (licenseLink) {
      if (licenseLink.includes('licenses/by/4.0')) rights = 'CC-BY-4.0';
      else if (licenseLink.includes('licenses/by-sa/4.0'))
        rights = 'CC-BY-SA-4.0';
      else if (licenseLink.includes('publicdomain/zero/1.0'))
        rights = 'CC0-1.0';
      else if (licenseLink.includes('nonexclusive-distrib'))
        rights = 'arXiv.org perpetual, non-exclusive license';
      else rights = licenseLink;
    }
  }

  const itemType: ParsedFeedEntry['itemType'] =
    arxivId && !publicationTitle
      ? 'preprint'
      : publicationTitle || doi
        ? 'journalArticle'
        : format === 'atom' && arxivId
          ? 'preprint'
          : 'journalArticle';

  return {
    id: stripCdataAndHtml(rawId),
    title,
    url,
    pdfUrl,
    doi,
    arxivId,
    primaryCategory,
    authors,
    creators,
    abstract: cleanedAbstract,
    publicationTitle: publicationTitle
      ? cleanBibliographicText(publicationTitle)
      : undefined,
    volume,
    issue,
    pages,
    publicationDate,
    year,
    keywords,
    rights,
    itemType,
  };
}

/**
 * Parses an RSS 2.0, RDF/RSS 1.0 (PRISM/Dublin Core), or Atom 1.0 XML feed
 * into normalized academic feed entries ready for Zotero feed preview or library promotion.
 */
export function parseAcademicFeedXml(xml: string): ParsedAcademicFeed {
  if (!xml || typeof xml !== 'string') {
    return { format: 'rss2', entries: [] };
  }

  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const isRdf = /<rdf:RDF[\s>]/i.test(xml) || /xmlns:prism=/i.test(xml);
  const format: FeedFormat = isAtom ? 'atom' : isRdf ? 'rss1-rdf' : 'rss2';

  // Extract feed-level header metadata before the first <item> or <entry>
  const firstEntryIdx = xml.search(/<(?:item|entry)[\s>]/i);
  const headerXml = firstEntryIdx > 0 ? xml.slice(0, firstEntryIdx) : xml;
  const feedTitle = extractTagValue(headerXml, ['title', 'dc:title']);
  const feedUrl = extractTagValue(headerXml, ['link']);
  const updatedAt = extractTagValue(headerXml, [
    'updated',
    'lastBuildDate',
    'pubDate',
    'dc:date',
  ]);

  const entries: ParsedFeedEntry[] = [];
  const tag = isAtom ? 'entry' : 'item';
  const entryRegex = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    'gi',
  );

  for (const match of xml.matchAll(entryRegex)) {
    const fullEntryXml = match[0];
    const parsed = parseFeedEntryXml(fullEntryXml, format);
    if (parsed) {
      entries.push(parsed);
    }
  }

  return {
    format,
    feedTitle,
    feedUrl,
    updatedAt,
    entries,
  };
}

/**
 * Promotes a parsed RSS/Atom feed entry into a user's Personal Library (`projectId: undefined`)
 * or Project Library (`projectId`), with optional duplicate guard by DOI / arXiv ID.
 */
export async function promoteFeedEntryToLibrary(
  entry: ParsedFeedEntry,
  userId: string,
  catalogPort: FeedPromotionCatalogPort,
  options: PromoteFeedEntryOptions = {},
): Promise<PromoteFeedEntryResult> {
  const effectiveProjectId =
    options.projectId &&
    options.projectId !== 'personal' &&
    options.projectId !== 'user' &&
    options.projectId !== 'me'
      ? options.projectId
      : undefined;

  if (catalogPort.findExistingByIdentifier) {
    const existing = await catalogPort.findExistingByIdentifier(userId, {
      doi: entry.doi,
      arxivId: entry.arxivId,
      url: entry.url,
      projectId: effectiveProjectId,
    });
    if (existing) {
      return {
        item: {
          id: existing.id,
          title: existing.title,
          projectId: effectiveProjectId ?? null,
        },
        deduplicated: true,
        feedEntryId: entry.id,
      };
    }
  }

  const combinedTags = normalizeTags([
    ...(entry.keywords || []),
    ...(options.tags || []),
  ]);

  const created = await catalogPort.createItem(userId, {
    title: entry.title,
    itemType: entry.itemType,
    authors: entry.authors,
    creators: entry.creators,
    year: entry.year ?? undefined,
    doi: entry.doi,
    url: entry.url,
    abstract: entry.abstract,
    publicationTitle: entry.publicationTitle,
    projectId: effectiveProjectId,
    collectionIds: options.collectionId ? [options.collectionId] : undefined,
    tags: combinedTags,
    metadata: {
      source: 'rss_atom_feed',
      feedEntryId: entry.id,
      arxivId: entry.arxivId,
      primaryCategory: entry.primaryCategory,
      pdfUrl: entry.pdfUrl,
      volume: entry.volume,
      issue: entry.issue,
      pages: entry.pages,
      publicationDate: entry.publicationDate,
      rights: entry.rights,
    },
  });

  return {
    item: created,
    deduplicated: false,
    feedEntryId: entry.id,
  };
}
