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
  projectId?: string;
}

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

import { parseAnnotationSortIndex as canonicalParseAnnotationSortIndex } from '../../shared-kernel/utils/sort-index.utils';

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

import {
  stripNoteHtml,
  buildTipTapDocFromText,
} from '../../shared-kernel/utils/tiptap.utils';

export { stripNoteHtml, buildTipTapDocFromText };

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
