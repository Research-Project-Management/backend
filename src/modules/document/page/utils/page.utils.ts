/**
 * page.utils.ts
 *
 * Server-authoritative utility functions for document and page processing:
 *  - XSS-safe title and content sanitization
 *  - Slug generation
 *  - LaTeX boilerplate wrapping for raw/bare manuscript fragments
 *  - Safe path validation
 *  - Canonical project ID resolution
 */

export function sanitizeDocumentTitle(rawTitle: string): string {
  if (!rawTitle) return 'Untitled Document';
  const sanitized = rawTitle
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, 255) : 'Untitled Document';
}

/**
 * Universal content string extractor:
 * Safely extracts raw text/source string from either plain string or structured editor/CRDT objects.
 */
export function toContentString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    return (
      (obj.source as string) ||
      (obj.text as string) ||
      (obj.content as string) ||
      JSON.stringify(content)
    );
  }
  return '';
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function sanitizeCommentContent(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '')
    .replace(/javascript:[^"'\s]*/gi, '')
    .trim();
}

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

export function validateSafePath(rawPath: string, fieldName = 'path'): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  if (rawPath.includes('\0')) {
    throw new Error(`Null bytes are prohibited in ${fieldName}`);
  }

  const normalized = rawPath.replace(/\\/g, '/').trim();

  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Drive letters are prohibited in ${fieldName}`);
  }

  if (normalized.startsWith('/')) {
    throw new Error(
      `Absolute paths starting with '/' are prohibited in ${fieldName}`,
    );
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Path traversal ('..') is prohibited in ${fieldName}`);
    }
  }

  return normalized;
}

import { isUUID as isUuid } from 'class-validator';

export async function resolveCanonicalProjectId(
  prisma: {
    project?: { findFirst: (args: any) => Promise<{ id: string } | null> };
  },
  projectId: string,
): Promise<string | null> {
  if (isUuid(projectId)) {
    return projectId;
  }
  if (!prisma?.project) {
    return null;
  }
  const proj = await prisma.project
    .findFirst({
      where: {
        identifier: { equals: projectId, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true },
    })
    .catch(() => null);
  return proj?.id ?? null;
}
