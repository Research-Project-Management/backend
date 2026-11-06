import { isInstitutionName } from './author.domain';
import { decodeHtmlEntities } from '@/modules/library/core/domain/text.domain';

/**
 * Attachment File Renamer Utility (Zotero 7 Official Standard)
 *
 * Implements Zotero 7 standard pattern-based attachment file renaming based on
 * parent item metadata (FirstCreator, Creators, Year, Title, PublicationTitle, etc.).
 * Supports official Zotero 7 template variables, modifiers (suffix, prefix, truncate, join),
 * and guarantees cross-platform filesystem safety (Windows, macOS, Linux).
 *
 * Official Zotero 7 Reference:
 * Default template: {{ firstCreator suffix=" - " }}{{ year suffix=" - " }}{{ title truncate="100" }}
 */

interface RenamerContributor {
  creatorType?: string | null;
  fieldMode?: number | string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  name?: string | null;
  orderIndex?: number | null;
}

export interface RenamerItemMetadata {
  title?: string | null;
  shortTitle?: string | null;
  year?: number | null;
  publicationDate?: string | null;
  date?: string | null;
  publicationTitle?: string | null;
  journalAbbr?: string | null;
  publisher?: string | null;
  citationKey?: string | null;
  itemType?: string | null;
  doi?: string | null;
  metadata?: unknown;
  contributors?: RenamerContributor[] | null;
}

/**
 * Official Zotero 7 Default Renaming Template.
 * @see https://www.zotero.org/support/file_renaming
 */
export const DEFAULT_RENAME_PATTERN =
  '{{ firstCreator suffix=" - " }}{{ year suffix=" - " }}{{ title truncate="100" }}';

const INSTITUTIONAL_NAME_REGEX =
  /\b(organization|consortium|association|institute|university|laboratory|committee|team|group|corporation|inc\.?|llc|agency|department|ministry|academy|bureau|council|center|centre|foundation|society|openai|google|microsoft|meta|deepmind|who|unesco|ieee|acm|đại học|học viện|viện|trung tâm|bộ giáo dục|bộ y tế|bộ khoa học|tổng cục|cục|sở|ngân hàng|ban quản lý|hội đồng|liên minh)\b/i;

/**
 * Extracts author token variations from a list of contributors.
 */
export function extractAuthorTokens(
  contributors?: RenamerContributor[] | null,
): {
  authors: string;
  firstAuthor: string;
  allAuthors: string;
  lastNames: string[];
} {
  if (
    !contributors ||
    !Array.isArray(contributors) ||
    contributors.length === 0
  ) {
    return { authors: '', firstAuthor: '', allAuthors: '', lastNames: [] };
  }

  // Filter for authors first; if none, use all contributors
  const authorList = contributors
    .slice()
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

  const authorsOnly = authorList.filter(
    (c) => !c.creatorType || c.creatorType.toLowerCase() === 'author',
  );
  const targetList = authorsOnly.length > 0 ? authorsOnly : authorList;

  const lastNames = targetList
    .map((c) => {
      const candidateCorpName = c.fullName || c.name || '';
      const isCorporate =
        c.fieldMode === 1 ||
        c.fieldMode === '1' ||
        (!c.firstName &&
          Boolean(candidateCorpName) &&
          (INSTITUTIONAL_NAME_REGEX.test(candidateCorpName) ||
            isInstitutionName(candidateCorpName)));

      if (isCorporate) {
        return (c.fullName || c.name || c.lastName || '').trim();
      }
      if (c.lastName && c.lastName.trim()) {
        return c.lastName.trim();
      }
      const raw = (c.fullName || c.name || '').trim();
      if (raw) {
        if (raw.includes(',')) {
          return raw.split(',')[0].trim();
        }
        const parts = raw.split(/\s+/);
        return parts[parts.length - 1];
      }
      return '';
    })
    .filter(Boolean);

  if (lastNames.length === 0) {
    return { authors: '', firstAuthor: '', allAuthors: '', lastNames: [] };
  }

  const firstAuthor = lastNames[0];
  const allAuthors = lastNames.join(', ');

  let authors = firstAuthor;
  if (lastNames.length === 2) {
    authors = `${lastNames[0]} and ${lastNames[1]}`;
  } else if (lastNames.length > 2) {
    authors = `${lastNames[0]} et al.`;
  }

  return { authors, firstAuthor, allAuthors, lastNames };
}

/**
 * Extracts 4-digit publication year.
 */
function extractYearToken(item: RenamerItemMetadata): string {
  if (item.year && item.year > 0) {
    return String(item.year);
  }
  const metaObj =
    item.metadata &&
    typeof item.metadata === 'object' &&
    !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : undefined;
  const rawDate =
    item.publicationDate ||
    item.date ||
    (typeof metaObj?.publicationDate === 'string'
      ? metaObj.publicationDate
      : undefined) ||
    (typeof metaObj?.date === 'string' ? metaObj.date : undefined);
  if (rawDate) {
    const match = rawDate.match(/\b(1[7-9]\d\d|20\d\d)\b/);
    if (match) return match[1];
  }
  return '';
}

/**
 * Sanitizes a filename stem for safe cross-platform storage (Windows, POSIX, macOS).
 * Removes illegal characters: \ / : * ? " < > | and ASCII control characters.
 */
export function sanitizeFilenameStem(stem: string, maxLength = 120): string {
  if (!stem) return 'document';

  let cleaned = stem
    // Replace illegal path characters
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    // Replace consecutive spaces or dashes
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    // Trim leading/trailing spaces, dots, and hyphens
    .trim()
    .replace(/^[\s.\-_]+|[\s.\-_]+$/g, '');

  if (!cleaned) {
    cleaned = 'document';
  }

  // Truncate to maximum stem length safely without splitting characters
  if (cleaned.length > maxLength) {
    cleaned = cleaned
      .slice(0, maxLength)
      .trim()
      .replace(/[\s.\-_]+$/, '');
  }

  return cleaned || 'document';
}

/**
 * Preserves or determines the file extension (e.g., '.pdf').
 */
export function resolveFileExtension(
  currentFilename?: string,
  fallback = '.pdf',
): string {
  if (!currentFilename) return fallback;
  const match = currentFilename.match(/(\.[a-zA-Z0-9]{2,10})$/);
  return match ? match[1].toLowerCase() : fallback;
}

/**
 * Formats an attachment filename according to the official Zotero 7 template engine.
 */
export function formatAttachmentFilename(
  pattern: string,
  item: RenamerItemMetadata,
  currentFilename?: string,
): string {
  const extension = resolveFileExtension(currentFilename);
  const effectivePattern =
    pattern && pattern.trim() ? pattern.trim() : DEFAULT_RENAME_PATTERN;

  const metaObj =
    item.metadata &&
    typeof item.metadata === 'object' &&
    !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : undefined;

  const { authors, firstAuthor, allAuthors, lastNames } = extractAuthorTokens(
    item.contributors,
  );
  const year = extractYearToken(item);
  const rawShortTitle =
    item.shortTitle ||
    (typeof metaObj?.shortTitle === 'string' ? metaObj.shortTitle : '');
  const rawTitle = (item.title || rawShortTitle || '').trim();
  // Strip trailing extension from title so we never produce `.pdf.pdf`
  const extRegex = new RegExp(`(?:${extension.replace('.', '\\.')})+$`, 'i');
  const title = rawTitle.replace(extRegex, '').trim();
  const shortTitle = rawShortTitle.trim().replace(extRegex, '').trim();

  const journal = (
    item.publicationTitle ||
    item.journalAbbr ||
    item.publisher ||
    (typeof metaObj?.publicationTitle === 'string'
      ? metaObj.publicationTitle
      : '') ||
    (typeof metaObj?.journalAbbr === 'string' ? metaObj.journalAbbr : '') ||
    (typeof metaObj?.publisher === 'string' ? metaObj.publisher : '') ||
    ''
  ).trim();
  const citationKey = (
    item.citationKey ||
    (typeof metaObj?.citationKey === 'string' ? metaObj.citationKey : '') ||
    ''
  ).trim();
  const itemType = (item.itemType || '').trim();
  const doi = (
    item.doi ||
    (typeof metaObj?.doi === 'string' ? metaObj.doi : '') ||
    ''
  )
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim();

  const resolveVariable = (
    tokenName: string,
    rawAttrs: string = '',
  ): string => {
    const lowerToken = tokenName.toLowerCase();
    const prefixMatch = rawAttrs.match(/prefix=(?:"([^"]*)"|'([^']*)')/);
    const suffixMatch = rawAttrs.match(/suffix=(?:"([^"]*)"|'([^']*)')/);
    const truncateMatch = rawAttrs.match(/truncate=(?:"(\d+)"|'(\d+)'|(\d+))/);
    const joinMatch = rawAttrs.match(/join=(?:"([^"]*)"|'([^']*)')/);

    const prefix = prefixMatch ? (prefixMatch[1] ?? prefixMatch[2] ?? '') : '';
    const suffix = suffixMatch ? (suffixMatch[1] ?? suffixMatch[2] ?? '') : '';
    const truncate = truncateMatch
      ? parseInt(truncateMatch[1] ?? truncateMatch[2] ?? truncateMatch[3], 10)
      : 0;
    const join = joinMatch ? (joinMatch[1] ?? joinMatch[2] ?? '') : '';

    let value = '';
    if (
      lowerToken === 'firstcreator' ||
      lowerToken === 'firstauthor' ||
      lowerToken === 'author'
    ) {
      value = firstAuthor;
    } else if (
      lowerToken === 'authors' ||
      lowerToken === 'creators' ||
      lowerToken === 'creator'
    ) {
      if (join && lastNames.length > 0) {
        value = lastNames.join(join);
      } else {
        value = authors;
      }
    } else if (lowerToken === 'allauthors') {
      value = allAuthors;
    } else if (lowerToken === 'year' || lowerToken === 'date') {
      value = year;
    } else if (lowerToken === 'title') {
      value = title;
    } else if (lowerToken === 'shorttitle') {
      value = shortTitle || title;
    } else if (
      lowerToken === 'publicationtitle' ||
      lowerToken === 'journal' ||
      lowerToken === 'publication'
    ) {
      value = journal;
    } else if (lowerToken === 'citationkey' || lowerToken === 'citekey') {
      value = citationKey;
    } else if (lowerToken === 'itemtype' || lowerToken === 'type') {
      value = itemType;
    } else if (lowerToken === 'doi') {
      value = doi;
    }

    value = value.trim();
    if (!value) return '';

    if (truncate > 0 && value.length > truncate) {
      value = value.slice(0, truncate).trim();
    }

    return `${prefix}${value}${suffix}`;
  };

  // 1. Replace double-brace Zotero 7 tokens: {{ token attr="val" }}
  let formatted = effectivePattern.replace(
    /\{\{\s*([a-zA-Z0-9_]+)([^}]*)\}\}/g,
    (_fullMatch, tokenName: string, rawAttrs: string) =>
      resolveVariable(tokenName, rawAttrs),
  );

  // 2. Replace single-brace shorthand tokens: {author}, {year}, {title}, {citationKey}, etc.
  formatted = formatted.replace(
    /\{\s*([a-zA-Z0-9_]+)(\s+[^}]*)?\}/g,
    (_fullMatch, tokenName: string, rawAttrs?: string) =>
      resolveVariable(tokenName, rawAttrs || ''),
  );

  // Clean up redundant separators when tokens are missing
  formatted = formatted
    .replace(/(?:\s*-\s*){2,}/g, ' - ')
    .replace(/^\s*-\s*|\s*-\s*$/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/(?:_\s*){2,}/g, '_')
    .replace(/^[\s_-]+|[\s_-]+$/g, '');

  // Strip trailing extension if template itself ended with `.pdf`
  formatted = formatted.replace(extRegex, '').trim();

  const sanitizedStem = sanitizeFilenameStem(formatted);
  return `${sanitizedStem}${extension}`;
}

/**
 * Shared TipTap / ProseMirror Document Utilities & Zotero Annotation Sort Index Utilities
 * Framework-agnostic document format transformers used across Library contexts.
 */

const COORD_SCALE = 10_000;
const PAGE_PAD = 4;
const COORD_PAD = 5;
const MAX_SORT_PAGE = 9_999;
const MAX_SORT_COORD = 99_999;

interface ParsedSortIndex {
  page: number;
  y: number;
  x: number;
  charOffset?: number;
}

/**
 * Build a Zotero-compatible annotation sort index string ("PPPP|YYYYY|XXXXX" or "PPPPP|OOOOOO|YYYYY").
 * When charOffset is provided, produces Zotero 7's 2-column reading order format "PPPPP|OOOOOO|YYYYY".
 */
export function buildAnnotationSortIndex(
  pageIndex: number,
  y = 0,
  x = 0,
  charOffset?: number,
): string {
  const safePage = Number.isFinite(pageIndex) ? pageIndex : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const safeX = Number.isFinite(x) ? x : 0;

  if (typeof charOffset === 'number' && Number.isFinite(charOffset)) {
    const p5 = String(
      Math.min(99_999, Math.max(0, Math.round(safePage))),
    ).padStart(5, '0');
    const offset6 = String(
      Math.min(999_999, Math.max(0, Math.round(charOffset))),
    ).padStart(6, '0');
    const yy5 = String(
      Math.min(MAX_SORT_COORD, Math.max(0, Math.round(safeY * COORD_SCALE))),
    ).padStart(COORD_PAD, '0');
    return `${p5}|${offset6}|${yy5}`;
  }

  const p = String(
    Math.min(MAX_SORT_PAGE, Math.max(0, Math.round(safePage))),
  ).padStart(PAGE_PAD, '0');
  const yy = String(
    Math.min(MAX_SORT_COORD, Math.max(0, Math.round(safeY * COORD_SCALE))),
  ).padStart(COORD_PAD, '0');
  const xx = String(
    Math.min(MAX_SORT_COORD, Math.max(0, Math.round(safeX * COORD_SCALE))),
  ).padStart(COORD_PAD, '0');
  return `${p}|${yy}|${xx}`;
}

/**
 * Parse a sort index string back into its components.
 * Supports both Flux ("PPPP|YYYYY|XXXXX") and Zotero 7 ("PPPPP|OOOOOO|YYYYY") formats.
 * Returns null if the format is invalid.
 */
export function parseAnnotationSortIndex(
  sortIndex?: string | null,
): ParsedSortIndex | null {
  if (!sortIndex) return null;
  const parts = sortIndex.split('|');
  if (parts.length !== 3) return null;

  const [p, seg2, seg3] = parts.map(Number);
  if ([p, seg2, seg3].some(isNaN)) return null;

  if (parts[1].length === 6) {
    return {
      page: p,
      charOffset: seg2,
      y: seg3 / COORD_SCALE,
      x: 0,
    };
  }

  return {
    page: p,
    y: seg2 / COORD_SCALE,
    x: seg3 / COORD_SCALE,
  };
}

interface TipTapInlineNode {
  type: 'text';
  text: string;
  marks?: Array<
    | { type: 'bold' | 'italic' | 'code' }
    | { type: 'link'; attrs: { href: string } }
  >;
}

/**
 * Strips HTML tags from content, returning clean plain text.
 */
export function stripNoteHtml(content: string): string {
  if (!content) return '';
  const stripped = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*[/]?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(stripped)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseInlineMarkdownNodes(rawText: string): TipTapInlineNode[] {
  if (!rawText) return [];
  const tokenRegex =
    /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  const parts = rawText.split(tokenRegex).filter((part) => part.length > 0);
  if (parts.length <= 1 && !tokenRegex.test(rawText)) {
    return [{ type: 'text', text: rawText }];
  }

  const nodes: TipTapInlineNode[] = [];
  for (const part of parts) {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      nodes.push({
        type: 'text',
        text: linkMatch[1],
        marks: [{ type: 'link', attrs: { href: linkMatch[2] } }],
      });
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push({
        type: 'text',
        text: part.slice(2, -2),
        marks: [{ type: 'bold' }],
      });
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      nodes.push({
        type: 'text',
        text: part.slice(1, -1),
        marks: [{ type: 'italic' }],
      });
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push({
        type: 'text',
        text: part.slice(1, -1),
        marks: [{ type: 'code' }],
      });
    } else {
      nodes.push({ type: 'text', text: part });
    }
  }
  return nodes;
}

/**
 * Builds standard TipTap ProseMirror document JSON structure from markdown/text.
 */
export function buildTipTapDocFromText(text: string): Record<string, unknown> {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }

  const blocks = trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const docContent: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const headingMatch = block.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (headingMatch && lines.length === 1) {
      const level = headingMatch[1].length;
      docContent.push({
        type: 'heading',
        attrs: { level },
        content: parseInlineMarkdownNodes(headingMatch[2].trim()),
      });
      continue;
    }

    if (lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l))) {
      docContent.push({
        type: 'bulletList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: parseInlineMarkdownNodes(
                l.replace(/^[-*]\s+/, '').trim(),
              ),
            },
          ],
        })),
      });
      continue;
    }

    if (lines.length > 0 && lines.every((l) => /^\d+\.\s+/.test(l))) {
      docContent.push({
        type: 'orderedList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: parseInlineMarkdownNodes(
                l.replace(/^\d+\.\s+/, '').trim(),
              ),
            },
          ],
        })),
      });
      continue;
    }

    if (lines.length > 0 && lines.every((l) => /^>\s?/.test(l))) {
      const quoteText = lines
        .map((l) => l.replace(/^>\s?/, '').trim())
        .join('\n');
      docContent.push({
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: parseInlineMarkdownNodes(quoteText),
          },
        ],
      });
      continue;
    }

    docContent.push({
      type: 'paragraph',
      content: parseInlineMarkdownNodes(block),
    });
  }

  return {
    type: 'doc',
    content: docContent,
  };
}

/**
 * Extracts readable plain text / markdown from a TipTap / ProseMirror JSON document tree.
 */
export function extractPlainTextFromTipTap(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const blocks: string[] = [];

  const renderInline = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const n = node as Record<string, unknown>;
    if (n.type === 'text' && typeof n.text === 'string') {
      return n.text;
    }
    if (n.type === 'hardBreak') {
      return '\n';
    }
    if (Array.isArray(n.content)) {
      return n.content.map(renderInline).join('');
    }
    return '';
  };

  const walkBlock = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const type = typeof n.type === 'string' ? n.type : '';

    if (type === 'doc') {
      if (Array.isArray(n.content)) {
        for (const child of n.content) {
          walkBlock(child);
        }
      }
      return;
    }

    if (type === 'bulletList' || type === 'orderedList') {
      if (Array.isArray(n.content)) {
        const items: string[] = [];
        n.content.forEach((li, idx) => {
          const text = renderInline(li).trim();
          if (text) {
            items.push(type === 'orderedList' ? `${idx + 1}. ${text}` : `- ${text}`);
          }
        });
        if (items.length > 0) {
          blocks.push(items.join('\n'));
        }
      }
      return;
    }

    const text = renderInline(n).trim();
    if (text) {
      blocks.push(text);
    } else if (Array.isArray(n.content)) {
      for (const child of n.content) {
        walkBlock(child);
      }
    }
  };

  walkBlock(doc);
  return blocks.join('\n\n').trim();
}
