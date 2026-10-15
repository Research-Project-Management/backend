/**
 * git-bridge/core/use-cases/git-access.use-case.ts
 *
 * Issues/revokes personal Git access tokens (hash-only persistence in
 * UserSettings.editorConfig.gitTokens) and authorizes Basic-auth requests
 * against project membership roles.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  generateToken,
  parseBasicAuth,
  parseToken,
  ProjectRole,
  StoredGitToken,
  tokenMatches,
} from '@/modules/manuscripts/git-bridge/core/domain/git-bridge.domain';
import {
  GIT_ACCESS_REPOSITORY_PORT,
  type IGitAccessRepositoryPort,
} from '@/modules/manuscripts/git-bridge/core/ports/git-access-repository.port';

const MAX_TOKENS = 20;

export interface GitPrincipal {
  userId: string;
  role: ProjectRole | null;
}

@Injectable()
export class GitAccessUseCase {
  constructor(
    @Inject(GIT_ACCESS_REPOSITORY_PORT)
    private readonly repository: IGitAccessRepositoryPort,
  ) {}

  async listTokens(userId: string) {
    const { tokens } = await this.repository.readConfig(userId);
    return tokens.map(({ hash: _hash, ...rest }) => rest);
  }

  /** Returns the plaintext token exactly once. */
  async createToken(userId: string, label?: string) {
    const { editorConfig, tokens } = await this.repository.readConfig(userId);
    if (tokens.length >= MAX_TOKENS) {
      throw new Error(`At most ${MAX_TOKENS} git tokens are allowed`);
    }
    const { token, id, hash } = generateToken(userId);
    const stored: StoredGitToken = {
      id,
      label: (label || 'Git access token').slice(0, 100),
      hash,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await this.repository.writeTokens(userId, editorConfig, [
      ...tokens,
      stored,
    ]);
    const { hash: _h, ...publicInfo } = stored;
    return { ...publicInfo, token };
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const { editorConfig, tokens } = await this.repository.readConfig(userId);
    const next = tokens.filter((t) => t.id !== tokenId);
    if (next.length === tokens.length) return false;
    await this.repository.writeTokens(userId, editorConfig, next);
    return true;
  }

  /** Verifies a Basic auth header; returns userId or null. */
  async authenticate(authorization?: string): Promise<string | null> {
    const creds = parseBasicAuth(authorization);
    if (!creds) return null;
    const parsed = parseToken(creds.password);
    if (!parsed) return null;
    const { editorConfig, tokens } = await this.repository.readConfig(
      parsed.userId,
    );
    const match = tokens.find(
      (t) => t.id === parsed.tokenId && tokenMatches(creds.password, t),
    );
    if (!match) return null;
    const isActive = await this.repository.isActiveUser(parsed.userId);
    if (!isActive) return null;

    // Best-effort usage stamp (at most once per hour).
    const last = match.lastUsedAt ? Date.parse(match.lastUsedAt) : 0;
    if (Date.now() - last > 3_600_000) {
      match.lastUsedAt = new Date().toISOString();
      await this.repository
        .writeTokens(parsed.userId, editorConfig, tokens)
        .catch(() => undefined);
    }
    return parsed.userId;
  }

  async resolveRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    return this.repository.resolveProjectRole(projectId, userId);
  }
}
