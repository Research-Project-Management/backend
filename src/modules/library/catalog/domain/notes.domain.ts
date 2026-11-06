/**
 * Pure utility functions for the Notes submodule.
 */
import { parseAnnotationSortIndex as canonicalParseAnnotationSortIndex } from '@/modules/library/core';
import { stripNoteHtml } from '@/modules/library/core/domain/renamer.domain';

export { stripNoteHtml };

interface NoteAnnotationSource {
  id?: string;
  attachmentId?: string;
  type?: string | null;
  pageIndex?: number | null;
  pageNumber?: number | null;
  pageLabel?: string | null;
  annotationSortIndex?: string | null;
  color?: string | null;
  quoteText?: string | null;
  selectedText?: string | null;
  text?: string | null;
  comment?: string | null;
  tags?: string[] | null;
  createdAt?: Date | null;
}

interface NoteItemSource {
  id?: string | null;
  title?: string | null;
  citekey?: string | null;
  citationKey?: string | null;
  firstAuthor?: string | null;
  authors?: string[] | null;
  creators?: Array<{
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    name?: string | null;
  }>;
  contributors?: Array<{
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    name?: string | null;
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

export function parseAnnotationSortIndex(
  sortIndex: string | null | undefined,
): {
  y: number;
  x: number;
  charOffset?: number;
} {
  const parsed = canonicalParseAnnotationSortIndex(sortIndex);
  if (!parsed) return { y: 0, x: 0 };
  return { y: parsed.y, x: parsed.x, charOffset: parsed.charOffset };
}

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
      ALLOWED_URI_REGEXP:
        /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|flux|zotero):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      ALLOW_DATA_ATTR: false,
    })
    .replace(/^(\s*)(?:&gt;)+/gm, (match, ws: string) => {
      const count = (match.match(/&gt;/g) || []).length;
      return `${ws}${'>'.repeat(count)}`;
    })
    .trim();
}

export function isLiteratureNoteCandidate(
  note:
    | {
        id?: unknown;
        title?: unknown;
        content?: unknown;
        contentMd?: unknown;
        tags?: unknown;
        deletedAt?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (!note || typeof note !== 'object' || note.deletedAt) return false;
  const tags = Array.isArray(note.tags) ? note.tags : [];
  if (tags.includes('literature-note')) return true;
  const title = typeof note.title === 'string' ? note.title.trim() : '';
  if (title.startsWith('Literature Notes')) return true;
  const content =
    typeof note.contentMd === 'string'
      ? note.contentMd.trim()
      : typeof note.content === 'string'
        ? note.content.trim()
        : '';
  return content.startsWith('# Literature Notes:');
}

function resolveAnnotationPageIndex(ann: NoteAnnotationSource): number {
  if (typeof ann.pageIndex === 'number' && Number.isFinite(ann.pageIndex) && ann.pageIndex >= 0) {
    return ann.pageIndex;
  }
  if (typeof ann.pageNumber === 'number' && Number.isFinite(ann.pageNumber) && ann.pageNumber >= 1) {
    return ann.pageNumber - 1;
  }
  return 0;
}

function resolveAnnotationQuoteText(ann: NoteAnnotationSource): string {
  const raw = ann.quoteText ?? ann.selectedText ?? ann.text ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function extractFamilyNameFromFullName(rawName?: string | null): string | null {
  if (!rawName || typeof rawName !== 'string') return null;
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  if (trimmed.includes(',')) {
    return trimmed.split(',')[0].trim() || null;
  }
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || null;
}

function resolveItemCitationAuthorInfo(item: NoteItemSource): {
  authorList: string;
  authorCitationBase: string;
} {
  const creatorObjects =
    Array.isArray(item.creators) && item.creators.length > 0
      ? item.creators
      : Array.isArray(item.contributors) && item.contributors.length > 0
        ? item.contributors
        : null;

  let authorList = 'Unknown';
  let firstAuthorLastName = 'Unknown';
  let hasMultipleAuthors = false;

  if (creatorObjects && creatorObjects.length > 0) {
    const formattedNames = creatorObjects
      .map(
        (c) =>
          c.fullName?.trim() ||
          c.name?.trim() ||
          `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      )
      .filter(Boolean);
    if (formattedNames.length > 0) {
      authorList = formattedNames.join(', ');
    }
    const first = creatorObjects[0];
    firstAuthorLastName =
      first.lastName?.trim() ||
      extractFamilyNameFromFullName(first.fullName || first.name) ||
      first.firstName?.trim() ||
      'Unknown';
    hasMultipleAuthors = creatorObjects.length > 1;
  } else if (Array.isArray(item.authors) && item.authors.length > 0) {
    const cleanAuthors = item.authors
      .map((a) => (typeof a === 'string' ? a.trim() : ''))
      .filter(Boolean);
    if (cleanAuthors.length > 0) {
      authorList = cleanAuthors.join(', ');
      firstAuthorLastName =
        extractFamilyNameFromFullName(cleanAuthors[0]) || 'Unknown';
      hasMultipleAuthors = cleanAuthors.length > 1;
    }
  } else if (typeof item.firstAuthor === 'string' && item.firstAuthor.trim()) {
    authorList = item.firstAuthor.trim();
    firstAuthorLastName =
      extractFamilyNameFromFullName(item.firstAuthor) || 'Unknown';
  }

  const citationYear = item.year ? String(item.year) : 'n.d.';
  const authorCitationBase = `${firstAuthorLastName}${hasMultipleAuthors ? ' et al.' : ''}, ${citationYear}`;
  return { authorList, authorCitationBase };
}

function formatAnnotationBlocksMarkdown(
  item: NoteItemSource,
  annotations: NoteAnnotationSource[],
  options?: FormatNoteOptions,
): string {
  const lines: string[] = [];

  const sorted = [...annotations].sort((a, b) => {
    const pageA = resolveAnnotationPageIndex(a);
    const pageB = resolveAnnotationPageIndex(b);
    if (pageA !== pageB) return pageA - pageB;
    const coordA = parseAnnotationSortIndex(a.annotationSortIndex);
    const coordB = parseAnnotationSortIndex(b.annotationSortIndex);
    if (
      coordA.charOffset !== undefined &&
      coordB.charOffset !== undefined &&
      coordA.charOffset !== coordB.charOffset
    ) {
      return coordA.charOffset - coordB.charOffset;
    }
    if (coordA.y !== coordB.y) return coordA.y - coordB.y;
    if (coordA.x !== coordB.x) return coordA.x - coordB.x;
    const tA = a.createdAt ? a.createdAt.getTime() : 0;
    const tB = b.createdAt ? b.createdAt.getTime() : 0;
    return tA - tB;
  });

  const { authorCitationBase } = resolveItemCitationAuthorInfo(item);

  const showColorHeaders =
    options?.tagColor !== false && options?.tagColor !== 'false';
  const showComments = options?.includeComments !== false;

  let currentPage = -1;
  let currentColor: string | null = null;

  for (const ann of sorted) {
    const resolvedPageIndex = resolveAnnotationPageIndex(ann);
    const pageNum = resolvedPageIndex + 1;
    const displayPageLabel = ann.pageLabel?.trim() || String(pageNum);

    if (resolvedPageIndex !== currentPage) {
      currentPage = resolvedPageIndex;
      currentColor = null;
      lines.push(`### Page ${displayPageLabel}`);
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

    const citationLabel = `(${authorCitationBase}, p. ${displayPageLabel})`;
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
    const quoteText = resolveAnnotationQuoteText(ann);

    if (quoteText) {
      lines.push(`> "${quoteText.replace(/\n+/g, '\n> ')}"`);
      lines.push(`> — ${citationLink}`);
      lines.push('');
      if (showComments && ann.comment && ann.comment.trim()) {
        lines.push(`**Note:** ${ann.comment.trim()}`);
        lines.push('');
      }
    } else if (showComments && ann.comment && ann.comment.trim()) {
      lines.push(`**Note:** ${ann.comment.trim()} — ${citationLink}`);
      lines.push('');
    } else {
      lines.push(`- ${citationLink}`);
      lines.push('');
    }

    if (Array.isArray(ann.tags) && ann.tags.length > 0) {
      const cleanTags = ann.tags
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean);
      if (cleanTags.length > 0) {
        lines.push(`**Tags:** ${cleanTags.map((t) => `\`#${t}\``).join(' ')}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export function formatLiteratureNoteMarkdown(
  item: NoteItemSource,
  annotations: NoteAnnotationSource[],
  options?: FormatNoteOptions,
): string {
  const { authorList } = resolveItemCitationAuthorInfo(item);

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

  const body = formatAnnotationBlocksMarkdown(item, annotations, options);
  return body ? [...headerLines, body].join('\n') : headerLines.join('\n');
}

export function appendAnnotationsToLiteratureNoteMarkdown(
  item: NoteItemSource,
  existingMarkdown: string,
  allAnnotations: NoteAnnotationSource[],
  options?: FormatNoteOptions,
): { markdown: string; addedCount: number } {
  const trimmedExisting = (existingMarkdown || '').trim();
  if (!trimmedExisting) {
    return {
      markdown: formatLiteratureNoteMarkdown(item, allAnnotations, options),
      addedCount: allAnnotations.length,
    };
  }

  const unreferencedAnnotations = allAnnotations.filter(
    (a) => !a.id || !trimmedExisting.includes(`annotation=${a.id}`),
  );
  if (unreferencedAnnotations.length === 0) {
    return { markdown: trimmedExisting, addedCount: 0 };
  }

  const deltaBlocks = formatAnnotationBlocksMarkdown(
    item,
    unreferencedAnnotations,
    options,
  ).trim();

  return {
    markdown: deltaBlocks ? `${trimmedExisting}\n\n${deltaBlocks}` : trimmedExisting,
    addedCount: unreferencedAnnotations.length,
  };
}
