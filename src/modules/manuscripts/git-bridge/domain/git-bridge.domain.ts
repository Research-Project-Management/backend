/**
 * git-bridge/domain/git-bridge.domain.ts
 *
 * Pure rules for the Git Smart-HTTP bridge: repository naming, path safety,
 * text-vs-binary classification, access-token format and role permissions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export const GIT_SERVICES: ReadonlySet<string> = new Set([
  'git-upload-pack',
  'git-receive-pack',
]);

export const GIT_DEFAULT_BRANCH = 'main';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "<uuid>.git" | "<uuid>" -> uuid, else null. */
export function parseRepoName(repo: string): string | null {
  const id = repo.endsWith('.git') ? repo.slice(0, -4) : repo;
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** Extensions stored as editable Docstore documents (everything else -> Filestore). */
const TEXT_EXTENSIONS = new Set([
  'tex',
  'bib',
  'cls',
  'sty',
  'bst',
  'bbx',
  'cbx',
  'lbx',
  'dtx',
  'ins',
  'txt',
  'md',
  'markdown',
  'rtex',
  'ltx',
  'tikz',
  'pgf',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'cfg',
  'def',
  'clo',
  'fd',
  'ist',
  'gls',
  'nlo',
  'latexmkrc',
  'gitignore',
  'r',
  'py',
  'lua',
  'asy',
  'mp',
  'bbl',
]);

export function isTextPath(path: string, content?: Buffer): boolean {
  const base = path.split('/').pop() || path;
  const dot = base.lastIndexOf('.');
  const ext = (dot >= 0 ? base.slice(dot + 1) : base).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  if (!content) return true;
  if (content.includes(0)) return false;
  return Buffer.from(content.toString('utf8'), 'utf8').equals(content);
}

/**
 * Normalizes a repo-relative path to the project's "/a/b.tex" form.
 * Rejects traversal, absolute, empty segments and git internals.
 */
export function toProjectPath(repoPath: string): string {
  const clean = repoPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = clean.split('/');
  if (
    !clean ||
    segments.some(
      (s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git',
    )
  ) {
    throw new Error(`Unsafe path in push: ${repoPath}`);
  }
  return `/${segments.join('/')}`;
}

/** "/a/b.tex" -> "a/b.tex" (working-tree relative). */
export function toRepoPath(projectPath: string): string {
  return projectPath.replace(/^\/+/, '');
}

// ─── Access tokens ────────────────────────────────────────────────────────────

export const GIT_TOKEN_PREFIX = 'fluxgit';

export interface StoredGitToken {
  id: string;
  label: string;
  hash: string; // sha256 hex of the full token
  createdAt: string;
  lastUsedAt?: string | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Token format: fluxgit_<userId>_<tokenId>_<secret> */
export function generateToken(userId: string): {
  token: string;
  id: string;
  hash: string;
} {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const token = `${GIT_TOKEN_PREFIX}_${userId}_${id}_${secret}`;
  return { token, id, hash: hashToken(token) };
}

export function parseToken(
  token: string,
): { userId: string; tokenId: string } | null {
  const m = /^fluxgit_([0-9a-f-]{36})_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/i.exec(
    token,
  );
  if (!m || !UUID_RE.test(m[1])) return null;
  return { userId: m[1].toLowerCase(), tokenId: m[2] };
}

export function tokenMatches(token: string, stored: StoredGitToken): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parses "Authorization: Basic base64(user:password)"; password carries the token. */
export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  if (!header || !/^Basic\s+/i.test(header)) return null;
  try {
    const decoded = Buffer.from(
      header.replace(/^Basic\s+/i, ''),
      'base64',
    ).toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export type ProjectRole = 'owner' | 'coordinator' | 'contributor' | 'reviewer';

export function canRead(role: ProjectRole | null): boolean {
  return role !== null;
}

export function canWrite(role: ProjectRole | null): boolean {
  return role === 'owner' || role === 'coordinator' || role === 'contributor';
}

// ─── Push change set ──────────────────────────────────────────────────────────

export interface GitChange {
  status: 'A' | 'M' | 'D';
  path: string; // repo-relative
}

/** Parses `git diff --name-status -z --no-renames` output. */
export function parseNameStatusZ(output: string): GitChange[] {
  const parts = output.split('\0').filter((p) => p.length > 0);
  const changes: GitChange[] = [];
  let i = 0;
  while (i + 1 < parts.length) {
    const status = parts[i].charAt(0);
    if (status === 'A' || status === 'M' || status === 'D') {
      changes.push({ status, path: parts[i + 1] });
      i += 2;
    } else if (status === 'T') {
      changes.push({ status: 'M', path: parts[i + 1] });
      i += 2;
    } else if (status === 'R' && i + 2 < parts.length) {
      changes.push({ status: 'D', path: parts[i + 1] });
      changes.push({ status: 'A', path: parts[i + 2] });
      i += 3;
    } else if (status === 'C' && i + 2 < parts.length) {
      changes.push({ status: 'A', path: parts[i + 2] });
      i += 3;
    } else {
      i += 2;
    }
  }
  return changes;
}
