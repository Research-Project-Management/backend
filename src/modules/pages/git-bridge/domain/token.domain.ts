/**
 * git-bridge/domain/token.domain.ts
 * GoF Factory Method Value Object (`AccessTokenVo`) & Data-Driven Strategy (`AUTH_SCHEMES`)
 * for Git Personal Access Tokens (1NF atomic 8-char `hint` separated from `PAT_PREFIX`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_TTL_MS } from './policy';

export const PAT_PREFIX = 'fluxpat';

export interface TokenView {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function formatTokenPrefix(hint: string): string {
  return `${PAT_PREFIX}_${hint}`;
}

/**
 * GoF Value Object + Factory Method encapsulating PAT creation and constant-time verification.
 */
export class AccessTokenVo {
  private constructor(
    public readonly plaintext: string,
    public readonly hint: string,
    public readonly hash: string,
    public readonly label: string,
    public readonly expiresAt: Date,
  ) {}

  public get prefix(): string {
    return formatTokenPrefix(this.hint);
  }

  public static generate(
    rawLabel?: string | null,
    nowMs: number = Date.now(),
  ): AccessTokenVo {
    const secret = randomBytes(27).toString('base64url');
    const hint = secret.slice(0, 8);
    const plaintext = `${PAT_PREFIX}_${secret}`;
    const label = ((rawLabel ?? '').trim() || 'Git access token').slice(0, 100);
    return new AccessTokenVo(
      plaintext,
      hint,
      sha256Hex(plaintext),
      label,
      new Date(nowMs + TOKEN_TTL_MS),
    );
  }

  public static isPlausible(token: string): boolean {
    return (
      typeof token === 'string' &&
      token.length >= 32 &&
      token.length <= 160 &&
      /^fluxpat_[A-Za-z0-9_-]{24,}$/.test(token)
    );
  }

  public static verifyHash(candidateHex: string, storedHex: string): boolean {
    if (candidateHex.length !== 64 || storedHex.length !== 64) return false;
    const a = Buffer.from(candidateHex, 'hex');
    const b = Buffer.from(storedHex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * GoF Data-Driven Strategy Map for extracting PAT credentials from HTTP `Authorization` headers.
 */
const AUTH_SCHEMES: Record<string, (credentials: string) => string | null> = {
  bearer: (creds) => creds.trim() || null,
  basic: (creds) => {
    try {
      const decoded = Buffer.from(creds.trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx < 0) return null;
      const user = decoded.slice(0, idx).trim();
      const pass = decoded.slice(idx + 1).trim();
      return pass || user || null;
    } catch {
      return null;
    }
  },
};

export function parseAuthHeader(header?: string): string | null {
  if (!header || typeof header !== 'string') return null;
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx <= 0) return null;
  const scheme = header.slice(0, spaceIdx).toLowerCase();
  const parser = AUTH_SCHEMES[scheme];
  return parser ? parser(header.slice(spaceIdx + 1)) : null;
}
