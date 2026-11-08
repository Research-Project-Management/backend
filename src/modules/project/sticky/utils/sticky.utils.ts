import crypto from 'node:crypto';

/**
 * Sticky Note Domain Utilities
 *
 * Pure, stateless functions for color validation, sticky note formatting,
 * and RFC 9562 compliant UUID v7 generation.
 */

let lastTime = 0;
let seq = 0;

/**
 * Generates an RFC 9562 compliant UUID v7 string.
 * Time-ordered 128-bit identifier with 48-bit millisecond precision and monotonic sequence.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    seq = ((bytes[6] & 0x0f) << 8) | bytes[7];
  } else {
    seq = (seq + 1) & 0x0fff;
  }

  // 48-bit timestamp (milliseconds since Unix epoch)
  bytes[0] = (now / 0x10000000000) & 0xff;
  bytes[1] = (now / 0x100000000) & 0xff;
  bytes[2] = (now / 0x1000000) & 0xff;
  bytes[3] = (now / 0x10000) & 0xff;
  bytes[4] = (now / 0x100) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7: 0b0111 (0x70) in upper 4 bits, top 4 bits of seq in lower 4 bits
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  // Variant 1: 0b10 (0x80) in upper 2 bits (RFC 4122/9562)
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Checks whether a given string is a valid UUID v7 format.
 */
export function isUuidV7(id?: string | null): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

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
