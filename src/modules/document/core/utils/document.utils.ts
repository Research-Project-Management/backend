/**
 * document.utils.ts
 *
 * Server-authoritative utility functions for document and comment processing:
 *  - XSS-safe title and content sanitization
 *  - Slug generation
 *  - LaTeX boilerplate wrapping for raw/bare manuscript fragments
 */

/**
 * Sanitizes page/document titles by stripping HTML tags, script injections,
 * and unprintable control characters.
 */
export function sanitizeDocumentTitle(rawTitle: string): string {
  if (!rawTitle) return 'Untitled Document';
  const sanitized = rawTitle
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, 255) : 'Untitled Document';
}

/**
 * Converts a title string into a URL-friendly slug.
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Sanitizes comment and reply content, stripping executable scripts,
 * iframes, inline event handlers, and javascript: pseudo-protocols.
 */
export function sanitizeCommentContent(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '')
    .replace(/javascript:[^"'\s]*/gi, '')
    .trim();
}

/**
 * Checks if a string contains bare LaTeX content lacking \documentclass.
 * If so, wraps it inside a complete, compilable LaTeX article document.
 */
export function ensureCompilableLatex(source: string, title?: string): string {
  const trimmed = (source || '').trim();
  if (trimmed.includes('\\documentclass')) {
    return source;
  }

  const cleanTitle = title ? sanitizeDocumentTitle(title) : 'Flux Document';

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{cite}

\\title{${cleanTitle}}
\\date{\\today}

\\begin{document}
\\maketitle

${trimmed}

\\end{document}
`;
}

/**
 * Validates that a file or folder path does not contain path traversal vectors
 * (e.g. '../', '..\\', absolute root '/' or drive letter 'C:').
 * Returns the normalized safe relative path, or throws an error.
 */
export function validateSafePath(rawPath: string, fieldName = 'path'): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  // Check for null bytes
  if (rawPath.includes('\0')) {
    throw new Error(`Null bytes are prohibited in ${fieldName}`);
  }

  // Normalize backslashes to forward slashes
  const normalized = rawPath.replace(/\\/g, '/').trim();

  // Check for drive letters (e.g. C:)
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Drive letters are prohibited in ${fieldName}`);
  }

  // Check for absolute path
  if (normalized.startsWith('/')) {
    throw new Error(`Absolute paths starting with '/' are prohibited in ${fieldName}`);
  }

  // Check for directory traversal components
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Path traversal ('..') is prohibited in ${fieldName}`);
    }
  }

  return normalized;
}

