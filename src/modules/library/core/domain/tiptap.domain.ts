import { decodeHtmlEntities } from './academic-text.domain';

/**
 * Shared TipTap / ProseMirror Document Utilities & Zotero Annotation Sort Index Utilities
 * Framework-agnostic document format transformers used across Library contexts.
 */

export const COORD_SCALE = 10_000;
export const PAGE_PAD = 4;
export const COORD_PAD = 5;
export const MAX_SORT_PAGE = 9_999;
export const MAX_SORT_COORD = 99_999;

export interface ParsedSortIndex {
  page: number;
  y: number;
  x: number;
}

/**
 * Build a Zotero-compatible annotation sort index string ("PPPP|YYYYY|XXXXX").
 */
export function buildAnnotationSortIndex(
  pageIndex: number,
  y = 0,
  x = 0,
): string {
  const safePage = Number.isFinite(pageIndex) ? pageIndex : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const safeX = Number.isFinite(x) ? x : 0;
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
 * Returns null if the format is invalid.
 */
export function parseAnnotationSortIndex(
  sortIndex?: string | null,
): ParsedSortIndex | null {
  if (!sortIndex) return null;
  const parts = sortIndex.split('|');
  if (parts.length !== 3) return null;

  const [p, yy, xx] = parts.map(Number);
  if ([p, yy, xx].some(isNaN)) return null;

  return {
    page: p,
    y: yy / COORD_SCALE,
    x: xx / COORD_SCALE,
  };
}

/**
 * Compare two sort index strings lexicographically.
 */
export function compareSortIndex(indexA: string, indexB: string): number {
  return indexA < indexB ? -1 : indexA > indexB ? 1 : 0;
}

export interface TipTapInlineNode {
  type: 'text';
  text: string;
  marks?: Array<{ type: 'bold' | 'italic' | 'code' }>;
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
  const tokenRegex = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  const parts = rawText.split(tokenRegex).filter((part) => part.length > 0);
  if (parts.length <= 1 && !tokenRegex.test(rawText)) {
    return [{ type: 'text', text: rawText }];
  }

  const nodes: TipTapInlineNode[] = [];
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
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
