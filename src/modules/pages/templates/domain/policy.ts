/**
 * templates/domain/policy.ts
 * Canonical categories, compilers, Flux Space scopes (`personal` | `project`),
 * quotas, MIME map, slug normalizer, and `Role`-aligned RBAC predicates.
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

export const TEMPLATE_SCOPES = ['personal', 'project'] as const;

export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

export const MAX_TEMPLATE_FILES = 500;
export const MAX_TEMPLATE_FILE_BYTES = 50 * 1024 * 1024; // 50 MB (matches Pages Filestore)
export const MAX_TEMPLATE_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB per template
export const MAX_TEMPLATE_TAGS = 12;

const CATEGORY_SET: ReadonlySet<string> = new Set(TEMPLATE_CATEGORIES);
const COMPILER_SET: ReadonlySet<string> = new Set(TEMPLATE_COMPILERS);
const SCOPE_SET: ReadonlySet<string> = new Set(TEMPLATE_SCOPES);

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

export function assertScope(raw?: string | null): TemplateScope {
  if (!raw) return 'personal';
  if (!SCOPE_SET.has(raw)) {
    throw new InvalidTemplateError(`Unsupported template scope: "${raw}"`);
  }
  return raw as TemplateScope;
}

export function deriveTemplateScope(
  spaceId: string | null | undefined,
  spaceType?: 'personal' | 'project' | null,
  createdById?: string | null,
): TemplateScope | null {
  if (!spaceId) return null;
  if (spaceType === 'personal') return 'personal';
  if (spaceType === 'project') return 'project';
  if (createdById && spaceId.toLowerCase() === createdById.toLowerCase()) {
    return 'personal';
  }
  return 'project';
}

export function toTemplateSlug(rawName: string, fallbackSuffix?: string): string {
  const base = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const root = base || 'template';
  return fallbackSuffix ? `${root}-${fallbackSuffix}`.slice(0, 128) : root;
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
  spaceId: string | null;
  userId?: string | null;
  memberRole?: string | null;
}): boolean {
  if (!params.spaceId) return true;
  if (!params.userId) return false;
  if (params.spaceId.toLowerCase() === params.userId.toLowerCase()) return true;
  return Boolean(params.memberRole);
}

export function canManageTemplate(params: {
  spaceId: string | null;
  createdById?: string | null;
  userId: string;
  memberRole?: string | null;
}): boolean {
  if (!params.spaceId) return false;
  if (params.spaceId.toLowerCase() === params.userId.toLowerCase()) return true;
  if (
    params.createdById &&
    params.createdById.toLowerCase() === params.userId.toLowerCase() &&
    Boolean(params.memberRole)
  ) {
    return true;
  }
  return params.memberRole === 'owner' || params.memberRole === 'coordinator';
}
