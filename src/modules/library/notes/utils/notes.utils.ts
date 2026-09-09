/**
 * Pure utility functions for the Notes submodule.
 */

export interface NoteAnnotationSource {
  pageIndex: number;
  quoteText?: string | null;
  comment?: string | null;
}

export interface NoteItemSource {
  title?: string | null;
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

  const lines: string[] = [
    `# Literature Notes: ${item.title || 'Untitled'}`,
    '',
    `**Authors:** ${authorList}  `,
    `**Year:** ${item.year || 'N/A'} | **DOI:** ${doi}`,
    '',
    '---',
    '',
    '## Extracted Highlights & Annotations',
    '',
  ];

  let currentPage = -1;
  for (const ann of annotations) {
    if (ann.pageIndex !== currentPage) {
      currentPage = ann.pageIndex;
      lines.push(`### Page ${currentPage + 1}`);
      lines.push('');
    }

    if (ann.quoteText) {
      lines.push(`> ${ann.quoteText.trim().replace(/\\n+/g, '\n> ')}`);
      lines.push('');
    }

    if (ann.comment) {
      lines.push(`**Note:** ${ann.comment.trim()}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
