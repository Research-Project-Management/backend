/**
 * templates/domain/policy.ts
 * Canonical Overleaf categories, compilers, visibilities, quotas, MIME map, and RBAC predicates.
 * Zero legacy category aliases or silent string coercion.
 */

import { InvalidTemplateError } from './errors';

export const TEMPLATE_CATEGORIES = [
  'journal',
  'conference',
  'book',
  'letter',
  'assignment',
  'poster',
  'presentation',
  'report',
  'cv',
  'thesis',
  'other',
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_COMPILERS = [
  'pdflatex',
  'xelatex',
  'lualatex',
  'latex',
] as const;

export type TemplateCompiler = (typeof TEMPLATE_COMPILERS)[number];

export const TEMPLATE_VISIBILITIES = [
  'official',
  'workspace',
  'private',
] as const;

export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

export const MAX_TEMPLATE_FILES = 500;
export const MAX_TEMPLATE_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_TEMPLATE_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB per template
export const MAX_TEMPLATE_TAGS = 12;

const CATEGORY_SET: ReadonlySet<string> = new Set(TEMPLATE_CATEGORIES);
const COMPILER_SET: ReadonlySet<string> = new Set(TEMPLATE_COMPILERS);
const VISIBILITY_SET: ReadonlySet<string> = new Set(TEMPLATE_VISIBILITIES);

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  tex: 'text/x-tex',
  ltx: 'text/x-tex',
  latex: 'text/x-tex',
  bib: 'text/x-bibtex',
  bst: 'text/plain',
  cls: 'text/x-tex',
  sty: 'text/x-tex',
  def: 'text/plain',
  cfg: 'text/plain',
  md: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  eps: 'application/postscript',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function assertCategory(raw?: string | null): TemplateCategory {
  if (!raw) return 'other';
  if (!CATEGORY_SET.has(raw)) {
    throw new InvalidTemplateError(`Unsupported template category: "${raw}"`);
  }
  return raw as TemplateCategory;
}

export function assertCompiler(raw?: string | null): TemplateCompiler {
  if (!raw) return 'pdflatex';
  if (!COMPILER_SET.has(raw)) {
    throw new InvalidTemplateError(`Unsupported LaTeX compiler: "${raw}"`);
  }
  return raw as TemplateCompiler;
}

export function assertVisibility(raw?: string | null): TemplateVisibility {
  if (!raw) return 'private';
  if (!VISIBILITY_SET.has(raw)) {
    throw new InvalidTemplateError(`Unsupported template visibility: "${raw}"`);
  }
  return raw as TemplateVisibility;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

export function normalizeTemplatePath(rawPath: string): string {
  const clean = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean || clean.length > 512 || hasControlChar(clean)) {
    throw new InvalidTemplateError(`Unsafe template file path: "${rawPath}"`);
  }
  const parts = clean.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..' || seg.toLowerCase() === '.git') {
      throw new InvalidTemplateError(`Unsafe template file path: "${rawPath}"`);
    }
  }
  return parts.join('/');
}

export function normalizeTags(tags?: readonly string[] | null): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  const unique = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const clean = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_\s]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 64);
    if (clean) unique.add(clean);
    if (unique.size >= MAX_TEMPLATE_TAGS) break;
  }
  return Array.from(unique);
}

export function inferMimeType(pathname: string): string {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function canReadTemplate(params: {
  visibility: TemplateVisibility;
  createdById?: string | null;
  userId?: string | null;
  isOperator: boolean;
  canReadSpace: boolean;
}): boolean {
  if (params.visibility === 'official' || params.isOperator) return true;
  if (!params.userId) return false;
  if (params.createdById && params.createdById === params.userId) return true;
  return params.visibility === 'workspace' && params.canReadSpace;
}

export function canManageTemplate(params: {
  visibility: TemplateVisibility;
  createdById?: string | null;
  userId: string;
  isOperator: boolean;
  canWriteSpace: boolean;
}): boolean {
  if (params.isOperator) return true;
  if (params.visibility === 'official') return false;
  if (params.createdById && params.createdById === params.userId) return true;
  return params.visibility === 'workspace' && params.canWriteSpace;
}
