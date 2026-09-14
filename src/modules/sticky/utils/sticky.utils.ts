

/**
 * Sticky Note Domain Utilities
 *
 * Pure, stateless functions for color validation and sticky note formatting.
 */

export const ALLOWED_STICKY_COLORS = [
  'cyan-1',
  'cyan-2',
  'mint-1',
  'mint-2',
  'yellow-1',
  'lavender-1',
  'pink-1',
  'purple-1',
] as const;

export type StickyColor = (typeof ALLOWED_STICKY_COLORS)[number];

/**
 * Validates and normalizes sticky note color. Defaults to classic 'yellow-1'.
 */
export function normalizeStickyColor(color?: string | null): string {
  if (!color) return 'yellow-1';
  const clean = color.trim().toLowerCase();
  return (ALLOWED_STICKY_COLORS as readonly string[]).includes(clean)
    ? clean
    : 'yellow-1';
}

/**
 * Derives next rotating color based on the last used color.
 */
export function getNextStickyColor(currentColor?: string | null): string {
  if (!currentColor) return ALLOWED_STICKY_COLORS[0];
  const clean = currentColor.trim().toLowerCase();
  const idx = (ALLOWED_STICKY_COLORS as readonly string[]).indexOf(clean);
  if (idx === -1) return ALLOWED_STICKY_COLORS[0];
  return ALLOWED_STICKY_COLORS[(idx + 1) % ALLOWED_STICKY_COLORS.length];
}

/**
 * Server-authoritative check if a sticky note is considered completely empty.
 */
export function isStickyContentEmpty(
  title?: string | null,
  content?: string | null,
): boolean {
  if (title && title.trim().length > 0) return false;
  if (!content) return true;
  if (
    content.includes('<img') ||
    content.includes('<video') ||
    content.includes('<iframe')
  ) {
    return false;
  }
  const plainText = stripStickyHtml(content);
  return plainText.length === 0;
}

/**
 * Sanitizes rich text HTML content on server before persisting, preventing Stored XSS.
 * High-performance pure sanitizer that strips execution vectors without DOM dependencies.
 */
export function sanitizeStickyHtml(html?: string | null): string {
  if (!html) return '<p></p>';

  const clean = html
    // 1. Remove script tags and contents
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // 2. Remove style tags and contents
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // 3. Remove dangerous embed/execution tags
    .replace(
      /<\/?(?:iframe|object|embed|applet|meta|link|base|form)\b[^>]*>/gi,
      '',
    )
    // 4. Remove all on* event handlers (e.g. onerror=, onload=, onclick=)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // 5. Remove javascript: pseudo-protocol in attributes
    .replace(/(href|src)\s*=\s*["']?\s*javascript:[^"'>\s]*/gi, '$1=""')
    .trim();

  return clean || '<p></p>';
}

/**
 * Truncates sticky note preview text cleanly.
 */
export function truncateStickyContent(
  content: string,
  maxLength: number = 100,
): string {
  if (!content || content.length <= maxLength) return content || '';
  return `${content.slice(0, maxLength).trim()}...`;
}

/**
 * Strips HTML tags and collapses whitespace to plain text.
 */
export function stripStickyHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&zwnj;/g, ' ')
    .replace(/&zwj;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derives a clean display name/preview for a sticky note.
 * If title exists, use it. Otherwise, extract plain text preview from content.
 */
export function getStickyTitleOrPreview(
  title?: string | null,
  content?: string | null,
  maxLength: number = 60,
): string {
  if (title && title.trim()) return title.trim();
  const plainText = stripStickyHtml(content || '');
  if (!plainText) return 'Sticky note';
  if (plainText.length <= maxLength) return plainText;
  return `${plainText.slice(0, maxLength).trim()}...`;
}

