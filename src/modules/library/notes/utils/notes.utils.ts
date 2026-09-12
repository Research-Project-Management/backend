/**
 * Pure utility functions for the Notes submodule.
 */

export interface NoteAnnotationSource {
  pageIndex: number;
  annotationSortIndex?: string | null;
  color?: string | null;
  quoteText?: string | null;
  comment?: string | null;
  createdAt?: Date | null;
}

export interface NoteItemSource {
  title?: string | null;
  citekey?: string | null;
  creators?: Array<{
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
  }>;
  contributors?: Array<{
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
  }>;
  year?: number | null;
  doi?: string | null;
  identifiers?: Array<{ type: string; value: string }>;
}

/**
 * Maps Zotero-standard annotation hex colors to semantic emoji + label strings.
 * Colors follow the Zotero 7 palette (8 standard colors).
 */
const COLOR_LABEL_MAP: Record<string, string> = {
  '#ffd400': '🟡 Key Points',
  '#ff6666': '🔴 Critical',
  '#5fb236': '🟢 Methods',
  '#2ea8e5': '🔵 Questions',
  '#a28ae5': '🟣 Background',
  '#e56eee': '🩷 Interesting',
  '#f19837': '🟠 Important',
  '#aaaaaa': '⬜ Notes',
};

/**
 * Parses an ``annotationSortIndex`` string (format: ``PPPP|YYYYY|XXXXX``)
 * and returns numeric Y and X coordinates for spatial ordering.
 * Returns { y: 0, x: 0 } if the format is invalid or the value is null.
 */
export function parseAnnotationSortIndex(sortIndex: string | null | undefined): {
  y: number;
  x: number;
} {
  if (!sortIndex) return { y: 0, x: 0 };
  const parts = sortIndex.split('|');
  if (parts.length < 3) return { y: 0, x: 0 };
  const y = parseFloat(parts[1] ?? '0');
  const x = parseFloat(parts[2] ?? '0');
  return {
    y: isNaN(y) ? 0 : y,
    x: isNaN(x) ? 0 : x,
  };
}

/**
 * Strips HTML tags from content, returning clean plain text.
 */
export function stripNoteHtml(content: string): string {
  if (!content) return '';
  return content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*[/]?>/gi, '\n')

    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Builds standard TipTap ProseMirror document JSON structure from markdown/text.
 */
export function buildTipTapDocFromText(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', text: text || '' }],
  };
}

/**
 * Formats annotations and highlights extracted from PDF attachments into structured Markdown.
 * Annotations are sorted by page → Y coordinate → X coordinate (Zotero annotationSortIndex).
 * Highlights are grouped by color with semantic labels within each page section.
 */
export function formatLiteratureNoteMarkdown(
  item: NoteItemSource,
  annotations: NoteAnnotationSource[],
): string {
  const authorList =
    Array.isArray(item.creators) && item.creators.length > 0
      ? item.creators
          .map(
            (c) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          )
          .join(', ')
      : Array.isArray(item.contributors) && item.contributors.length > 0
        ? item.contributors
            .map(
              (c) =>
                c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
            )
            .join(', ')
        : 'Unknown';

  const doi =
    item.doi ||
    item.identifiers?.find((id) => id.type.toLowerCase() === 'doi')?.value ||
    'N/A';

  const headerLines: string[] = [
    `# Literature Notes: ${item.title || 'Untitled'}`,
    '',
    `**Authors:** ${authorList}  `,
    `**Year:** ${item.year || 'N/A'} | **DOI:** ${doi}`,
  ];

  if (item.citekey) {
    headerLines.push(`**@citekey:** ${item.citekey}`);
  }

  headerLines.push('', '---', '', '## Extracted Highlights & Annotations', '');

  const lines: string[] = headerLines;

  // Sort annotations: pageIndex ASC → Y coord ASC → X coord ASC → createdAt ASC
  const sorted = [...annotations].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    const coordA = parseAnnotationSortIndex(a.annotationSortIndex);
    const coordB = parseAnnotationSortIndex(b.annotationSortIndex);
    if (coordA.y !== coordB.y) return coordA.y - coordB.y;
    if (coordA.x !== coordB.x) return coordA.x - coordB.x;
    const tA = a.createdAt ? a.createdAt.getTime() : 0;
    const tB = b.createdAt ? b.createdAt.getTime() : 0;
    return tA - tB;
  });

  // Group by page, then by color within each page
  let currentPage = -1;
  let currentColor: string | null = null;

  for (const ann of sorted) {
    // New page heading
    if (ann.pageIndex !== currentPage) {
      currentPage = ann.pageIndex;
      currentColor = null;
      lines.push(`### Page ${currentPage + 1}`);
      lines.push('');
    }

    // Color group heading within page (only when color changes)
    const annColor = (ann.color ?? '').toLowerCase();
    const colorLabel = COLOR_LABEL_MAP[annColor] ?? '📌 General';
    if (annColor !== currentColor) {
      currentColor = annColor;
      lines.push(`#### ${colorLabel}`);
      lines.push('');
    }

    if (ann.quoteText) {
      lines.push(`> ${ann.quoteText.trim().replace(/\n+/g, '\n> ')}`);
      lines.push('');
    }

    if (ann.comment) {
      lines.push(`**Note:** ${ann.comment.trim()}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

