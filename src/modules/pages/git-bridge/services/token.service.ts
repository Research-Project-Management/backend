/**
 * git-bridge/services/token.service.ts
 * Personal Access Token lifecycle & Caching Proxy (`authCache`) for HTTP Basic/Bearer auth.
 */

import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { TokenLimitError } from '../domain/errors';
import { MAX_TOKENS, TOUCH_TTL_MS } from '../domain/policy';
import {
  AccessTokenVo,
  formatTokenPrefix,
  parseAuthHeader,
  sha256Hex,
  TokenView,
} from '../domain/token.domain';
import { GitBridgeRepository, TokenRecord } from '../git-bridge.repository';

interface AuthSession {
  readonly tokenId: string;
  readonly userId: string;
  readonly expiresMs: number;
  touchedMs: number;
}

@Injectable()
export class TokenService {
  /** GoF Caching Proxy: Coalesces Smart-HTTP auth checks across `info/refs` -> `upload/receive-pack`. */
  private readonly authCache = new LRUCache<string, AuthSession>({
    max: 512,
    ttl: 30_000,
  });

  constructor(private readonly repo: GitBridgeRepository) {}

  private toView(row: TokenRecord): TokenView {
    return {
      id: row.id,
      label: row.label,
      prefix: formatTokenPrefix(row.tokenHint),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    };
  }

  public async list(userId: string): Promise<TokenView[]> {
    const rows = await this.repo.listActiveTokens(userId);
    return rows.map((r) => this.toView(r));
  }

  public async create(
    userId: string,
    label?: string,
  ): Promise<TokenView & { token: string }> {
    const now = new Date();
    await this.repo.pruneUserExpired(userId, now);

    const active = await this.repo.countActiveTokens(userId, now);
    if (active >= MAX_TOKENS) {
      throw new TokenLimitError(MAX_TOKENS);
    }

    const vo = AccessTokenVo.generate(label, now.getTime());
    const saved = await this.repo.createToken({
      userId,
      label: vo.label,
      tokenHint: vo.hint,
      tokenHash: vo.hash,
      expiresAt: vo.expiresAt,
    });

    return { ...this.toView(saved), token: vo.plaintext };
  }

  public async revoke(userId: string, tokenId: string): Promise<boolean> {
    const removed = await this.repo.deleteToken(userId, tokenId);
    if (!removed) return false;
    this.authCache.delete(removed.tokenHash);
    return true;
  }

  public async authenticate(authHeader?: string): Promise<string | null> {
    const raw = parseAuthHeader(authHeader);
    if (!raw || !AccessTokenVo.isPlausible(raw)) return null;

    const hash = sha256Hex(raw);
    const nowMs = Date.now();

    const hit = this.authCache.get(hash);
    if (hit && hit.expiresMs > nowMs) {
      if (nowMs - hit.touchedMs > TOUCH_TTL_MS) {
        hit.touchedMs = nowMs;
        void this.repo.touchToken(hit.tokenId, new Date(nowMs));
      }
      return hit.userId;
    }

    const row = await this.repo.findByHash(hash);
    if (!row) return null;
    if (!AccessTokenVo.verifyHash(hash, row.tokenHash)) return null;
    if (row.expiresAt.getTime() <= nowMs) return null;
    if (!(await this.repo.isActiveUser(row.userId))) return null;

    const prevMs = row.lastUsedAt ? row.lastUsedAt.getTime() : 0;
    let touchedMs = prevMs;
    if (nowMs - prevMs > TOUCH_TTL_MS) {
      touchedMs = nowMs;
      void this.repo.touchToken(row.id, new Date(nowMs));
    }

    this.authCache.set(hash, {
      tokenId: row.id,
      userId: row.userId,
      expiresMs: row.expiresAt.getTime(),
      touchedMs,
    });
    return row.userId;
  }
}
