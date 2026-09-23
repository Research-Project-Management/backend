/**
 * Pure utility functions for the Notes submodule.
 */

export interface NoteAnnotationSource {
  id?: string;
  attachmentId?: string;
  pageIndex: number;
  annotationSortIndex?: string | null;
  color?: string | null;
  quoteText?: string | null;
  comment?: string | null;
  createdAt?: Date | null;
}

export interface NoteItemSource {
  id?: string | null;
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

export interface FormatNoteOptions {
  protocol?: 'flux' | 'web' | 'zotero';
  webBaseUrl?: string;
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
export function parseAnnotationSortIndex(
  sortIndex: string | null | undefined,
): {
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
 * Sanitizes note title:
 * - Strips all HTML tags and scripts
 * - Strips control characters
 * - Collapses excessive whitespace and trims
 * - Maximum 255 characters
 * - Defaults to 'Untitled Note' if empty
 */
export function sanitizeNoteTitle(title?: string | null): string {
  if (!title || typeof title !== 'string') return 'Untitled Note';
  let cleaned = stripNoteHtml(title).trim();
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > 255) {
    cleaned = cleaned.substring(0, 255).trim();
  }
  return cleaned || 'Untitled Note';
}

/**
 * Sanitizes note markdown/HTML content against stored XSS:
 * - Strips <script>, <style>, <iframe>, <object>, <embed>, <applet> tags and bodies
 * - Strips javascript: and vbscript: URIs
 * - Strips inline event handlers (onload, onerror, onclick, etc.)
 */
export function sanitizeNoteContent(content?: string | null): string {
  if (!content || typeof content !== 'string') return '';
  const cleaned = content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/<applet\b[^<]*(?:(?!<\/applet>)<[^<]*)*<\/applet>/gi, '')
    .replace(/(?:javascript|vbscript):[^\s"')]+/gi, '')
    .replace(/\son\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
  return cleaned.trim();
}

/**
 * Formats annotations and highlights extracted from PDF attachments into structured Markdown.
 * Annotations are sorted by page → Y coordinate → X coordinate (Zotero annotationSortIndex).
 * Highlights are grouped by color with semantic labels within each page section.
 */
export function formatLiteratureNoteMarkdown(
  item: NoteItemSource,
  annotations: NoteAnnotationSource[],
  options?: FormatNoteOptions,
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

  // Determine in-text citation prefix (e.g. "Vaswani et al., 2017")
  const firstCreator =
    Array.isArray(item.creators) && item.creators.length > 0
      ? item.creators[0]
      : null;
  const firstAuthorName = firstCreator
    ? firstCreator.lastName ||
      firstCreator.fullName?.split(' ').slice(-1)[0] ||
      'Unknown'
    : Array.isArray(item.contributors) && item.contributors.length > 0
      ? item.contributors[0].lastName || 'Unknown'
      : 'Unknown';
  const hasMultipleAuthors =
    (Array.isArray(item.creators) && item.creators.length > 1) ||
    (Array.isArray(item.contributors) && item.contributors.length > 1);
  const citationYear = item.year ? String(item.year) : 'n.d.';
  const authorCitationBase = `${firstAuthorName}${hasMultipleAuthors ? ' et al.' : ''}, ${citationYear}`;

  // Group by page, then by color within each page
  let currentPage = -1;
  let currentColor: string | null = null;

  for (const ann of sorted) {
    const pageNum = ann.pageIndex + 1;

    // New page heading
    if (ann.pageIndex !== currentPage) {
      currentPage = ann.pageIndex;
      currentColor = null;
      lines.push(`### Page ${pageNum}`);
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

    const citationLabel = `(${authorCitationBase}, p. ${pageNum})`;
    const protocol = options?.protocol || 'flux';
    let backlinkUrl = '';
    if (protocol === 'zotero') {
      const attId = ann.attachmentId || '0';
      backlinkUrl = `zotero://open-pdf/0_${attId}/${pageNum}?annotation=${ann.id || ''}`;
    } else if (protocol === 'web') {
      const base =
        (options?.webBaseUrl || '').replace(/\/$/, '') ||
        'https://app.flux.domain';
      const targetId = item.id || ann.attachmentId || '';
      backlinkUrl = `${base}/library/papers/${targetId}?page=${pageNum}&annotation=${ann.id || ''}`;
    } else {
      backlinkUrl = ann.attachmentId
        ? `flux://open-pdf/library/items/${ann.attachmentId}?page=${pageNum}&annotation=${ann.id || ''}`
        : `flux://open-pdf/library/items?page=${pageNum}&annotation=${ann.id || ''}`;
    }
    const citationLink = `[${citationLabel}](${backlinkUrl})`;

    if (ann.quoteText) {
      lines.push(`> "${ann.quoteText.trim().replace(/\n+/g, '\n> ')}"`);
      lines.push(`> — ${citationLink}`);
      lines.push('');
    }

    if (ann.comment) {
      lines.push(`**Note:** ${ann.comment.trim()}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
