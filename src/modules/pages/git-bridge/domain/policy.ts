/**
 * git-bridge/domain/policy.ts
 * Quotas, RBAC predicates, and `RepoPathVo` Value Object (GoF Factory Method).
 */

import { GitBridgeError } from './errors';

export type GitService = 'git-upload-pack' | 'git-receive-pack';
export type ProjectRole = 'owner' | 'coordinator' | 'contributor' | 'reviewer';

export const GIT_SERVICES: ReadonlySet<string> = new Set<GitService>([
  'git-upload-pack',
  'git-receive-pack',
]);

export const DEFAULT_BRANCH = 'main';
export const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;
export const GIT_USER = 'git';

/** Overleaf parity: max 10 active PATs per user, 1-year TTL. */
export const MAX_TOKENS = 10;
export const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const TOUCH_TTL_MS = 60 * 60 * 1000;

/** Workspace & push safety limits. */
export const MAX_FILES = 2_000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_PUSH_BYTES = 200 * 1024 * 1024; // 200 MB

/** Bare repo lifecycle & GC thresholds. */
export const IDLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const SWEEP_MS = 30 * 60 * 1000; // 30m
export const GC_THRESHOLD = 25;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canRead(
  role: ProjectRole | string | null | undefined,
): boolean {
  return Boolean(role);
}

export function canWrite(
  role: ProjectRole | string | null | undefined,
): boolean {
  return role === 'owner' || role === 'coordinator' || role === 'contributor';
}

export function parseRepoId(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const id = trimmed.toLowerCase().endsWith('.git')
    ? trimmed.slice(0, -4)
    : trimmed;
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * GoF Factory Method Value Object: Normalizes and validates paths between
 * Git trees (`chapters/intro.tex`) and Flux virtual structure (`/chapters/intro.tex`).
 */
export class RepoPathVo {
  public readonly repo: string;
  public readonly project: string;
  public readonly name: string;
  public readonly dir: string;
  public readonly segments: readonly string[];

  private constructor(segments: string[]) {
    this.segments = segments;
    this.repo = segments.join('/');
    this.project = `/${this.repo}`;
    this.name = segments[segments.length - 1];
    this.dir =
      segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : '/';
  }

  private static hasControlChar(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) <= 0x1f) return true;
    }
    return false;
  }

  public static fromRepo(rawPath: string): RepoPathVo {
    const clean = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || RepoPathVo.hasControlChar(clean) || clean.length > 512) {
      throw new GitBridgeError(`Unsafe path in Git tree: "${rawPath}"`);
    }
    const parts = clean.split('/');
    for (const seg of parts) {
      if (
        !seg ||
        seg === '.' ||
        seg === '..' ||
        seg.toLowerCase() === '.git' ||
        seg.endsWith(' ') ||
        seg.endsWith('.')
      ) {
        throw new GitBridgeError(`Unsafe path in Git tree: "${rawPath}"`);
      }
    }
    return new RepoPathVo(parts);
  }

  public static fromProject(projectPath: string): RepoPathVo {
    return RepoPathVo.fromRepo(projectPath);
  }
}
