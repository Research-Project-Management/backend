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
  citationKey?: string | null;
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
  projectId?: string;
  noteId?: string;
  attachmentId?: string;
  annotationIds?: string[];
  tagColor?: boolean | string;
  tagColorName?: string;
  includeComments?: boolean;
}

const COLOR_LABEL_MAP: Record<string, string> = {
  '#ffd400': '🟡 Key Points',
  '#ffeb3b': '🟡 Key Points',
  '#ffff00': '🟡 Key Points',
  yellow: '🟡 Key Points',
  '#ff6666': '🔴 Critical',
  '#f44336': '🔴 Critical',
  '#ff0000': '🔴 Critical',
  red: '🔴 Critical',
  '#5fb236': '🟢 Methods',
  '#4caf50': '🟢 Methods',
  '#00ff00': '🟢 Methods',
  green: '🟢 Methods',
  '#2ea8e5': '🔵 Questions',
  '#2196f3': '🔵 Questions',
  '#0000ff': '🔵 Questions',
  blue: '🔵 Questions',
  '#a28ae5': '🟣 Background',
  '#9c27b0': '🟣 Background',
  purple: '🟣 Background',
  '#e56eee': '🩷 Interesting',
  '#e91e63': '🩷 Interesting',
  magenta: '🩷 Interesting',
  pink: '🩷 Interesting',
  '#f19837': '🟠 Important',
  '#ff9800': '🟠 Important',
  orange: '🟠 Important',
  '#aaaaaa': '⬜ Notes',
  '#9e9e9e': '⬜ Notes',
  gray: '⬜ Notes',
  grey: '⬜ Notes',
};

import { parseAnnotationSortIndex as canonicalParseAnnotationSortIndex } from '@/modules/library/core';

export function parseAnnotationSortIndex(
  sortIndex: string | null | undefined,
): {
  y: number;
  x: number;
} {
  const parsed = canonicalParseAnnotationSortIndex(sortIndex);
  if (!parsed) return { y: 0, x: 0 };
  return { y: parsed.y, x: parsed.x };
}

import { stripNoteHtml } from '@/modules/library/core/domain/tiptap.domain';

export { stripNoteHtml };

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

interface HtmlPurifier {
  sanitize(raw: string, config?: Record<string, unknown>): string;
}

let domPurifyInstance: HtmlPurifier | null = null;

function getPurifyInstance(): HtmlPurifier {
  if (domPurifyInstance) return domPurifyInstance;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require('jsdom');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createDOMPurify = require('dompurify');
    const window = new JSDOM('').window;
    domPurifyInstance = createDOMPurify(window) as HtmlPurifier;
  } catch {
    // Fail closed: if DOMPurify cannot be initialised, strip ALL markup instead of
    // falling back to a bypassable regex sanitizer.
    domPurifyInstance = { sanitize: (raw: string) => stripNoteHtml(raw) };
  }
  return domPurifyInstance;
}

export function sanitizeNoteContent(content?: string | null): string {
  if (!content || typeof content !== 'string') return '';
  const purify = getPurifyInstance();
  return purify
    .sanitize(content, {
      ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        's',
        'strike',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'blockquote',
        'pre',
        'code',
        'ul',
        'ol',
        'li',
        'a',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'span',
        'div',
        'hr',
        'mark',
        'sub',
        'sup',
        'img',
      ],
      ALLOWED_ATTR: [
        'href',
        'target',
        'rel',
        'class',
        'style',
        'src',
        'alt',
        'width',
        'height',
      ],
      ALLOW_DATA_ATTR: false,
    })
    .replace(/^(\s*)(?:&gt;)+/gm, (match, ws: string) => {
      const count = (match.match(/&gt;/g) || []).length;
      return `${ws}${'>'.repeat(count)}`;
    })
    .trim();
}

export function validateTipTapDoc(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Record<string, unknown>;
  if (d.type !== 'doc') return false;
  if (!Array.isArray(d.content)) return false;
  for (const node of d.content) {
    if (
      !node ||
      typeof node !== 'object' ||
      typeof (node as Record<string, unknown>).type !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

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

  const citekey = item.citationKey || item.citekey;
  if (citekey) {
    headerLines.push(`**@citekey:** ${citekey}`);
  }

  headerLines.push('', '---', '', '## Extracted Highlights & Annotations', '');

  const lines: string[] = headerLines;

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

  const showColorHeaders =
    options?.tagColor !== false && options?.tagColor !== 'false';
  const showComments = options?.includeComments !== false;

  let currentPage = -1;
  let currentColor: string | null = null;

  for (const ann of sorted) {
    const pageNum = ann.pageIndex + 1;

    if (ann.pageIndex !== currentPage) {
      currentPage = ann.pageIndex;
      currentColor = null;
      lines.push(`### Page ${pageNum}`);
      lines.push('');
    }

    if (showColorHeaders) {
      const annColor = (ann.color ?? '').toLowerCase();
      const colorLabel =
        (typeof options?.tagColorName === 'string' &&
          options.tagColorName.trim()) ||
        COLOR_LABEL_MAP[annColor] ||
        '📌 General';
      if (annColor !== currentColor) {
        currentColor = annColor;
        lines.push(`#### ${colorLabel}`);
        lines.push('');
      }
    }

    const citationLabel = `(${authorCitationBase}, p. ${pageNum})`;
    const protocol = options?.protocol || 'flux';
    const targetItemId = item.id || ann.attachmentId || '';
    const attachmentParam = ann.attachmentId
      ? `attachmentId=${ann.attachmentId}&`
      : '';
    const projectPrefix =
      options?.projectId && options.projectId !== 'user' && options.projectId !== 'default'
        ? `/projects/${encodeURIComponent(options.projectId)}`
        : '';
    let backlinkUrl = '';
    if (protocol === 'zotero') {
      const attId = ann.attachmentId || '0';
      backlinkUrl = `zotero://open-pdf/0_${attId}/${pageNum}?annotation=${ann.id || ''}`;
    } else if (protocol === 'web') {
      const base = (options?.webBaseUrl || '').replace(/\/$/, '');
      const canonicalPath = `${projectPrefix}/library/papers/${targetItemId}?${attachmentParam}page=${pageNum}&annotation=${ann.id || ''}`;
      backlinkUrl = base ? `${base}${canonicalPath}` : canonicalPath;
    } else {
      backlinkUrl = targetItemId
        ? `flux://open-pdf${projectPrefix}/library/papers/${targetItemId}?${attachmentParam}page=${pageNum}&annotation=${ann.id || ''}`
        : `flux://open-pdf${projectPrefix}/library/papers?${attachmentParam}page=${pageNum}&annotation=${ann.id || ''}`;
    }
    const citationLink = `[${citationLabel}](${backlinkUrl})`;

    if (ann.quoteText) {
      lines.push(`> "${ann.quoteText.trim().replace(/\n+/g, '\n> ')}"`);
      lines.push(`> — ${citationLink}`);
      lines.push('');
    }

    if (showComments && ann.comment) {
      lines.push(`**Note:** ${ann.comment.trim()}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
