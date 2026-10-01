/**
 * Shared TipTap / ProseMirror Document Utilities
 * Framework-agnostic document format transformers used across Library contexts.
 */

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
 * TipTap paragraph nodes require `content: [{ type: 'text', text: '...' }]`,
 * NOT a bare `text` string property on the paragraph node itself.
 */
export function buildTipTapDocFromText(text: string): Record<string, unknown> {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }
  // Split on double newlines to create separate paragraph nodes
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return {
    type: 'doc',
    content: paragraphs.map((block) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: block }],
    })),
  };
}
