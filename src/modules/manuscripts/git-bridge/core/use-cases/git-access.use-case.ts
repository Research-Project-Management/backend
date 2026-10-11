/**
 * git-bridge/core/use-cases/git-access.use-case.ts
 *
 * Issues/revokes personal Git access tokens (hash-only persistence in
 * UserSettings.editorConfig.gitTokens) and authorizes Basic-auth requests
 * against project membership roles.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  generateToken,
  parseBasicAuth,
  parseToken,
  ProjectRole,
  StoredGitToken,
  tokenMatches,
} from '../domain/git-bridge.domain';

const MAX_TOKENS = 20;

export interface GitPrincipal {
  userId: string;
  role: ProjectRole | null;
}

@Injectable()
export class GitAccessUseCase {
  constructor(private readonly prisma: PrismaService) {}

  private async readConfig(userId: string) {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { editorConfig: true },
    });
    const editorConfig = (row?.editorConfig as Record<string, any>) || {};
    const tokens: StoredGitToken[] = Array.isArray(editorConfig.gitTokens)
      ? editorConfig.gitTokens
      : [];
    return { editorConfig, tokens };
  }

  private async writeTokens(
    userId: string,
    editorConfig: Record<string, any>,
    tokens: StoredGitToken[],
  ) {
    const next = {
      ...editorConfig,
      gitTokens: tokens,
    } as unknown as Prisma.InputJsonValue;
    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, editorConfig: next },
      update: { editorConfig: next },
    });
  }

  async listTokens(userId: string) {
    const { tokens } = await this.readConfig(userId);
    return tokens.map(({ hash: _hash, ...rest }) => rest);
  }

  /** Returns the plaintext token exactly once. */
  async createToken(userId: string, label?: string) {
    const { editorConfig, tokens } = await this.readConfig(userId);
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
    await this.writeTokens(userId, editorConfig, [...tokens, stored]);
    const { hash: _h, ...publicInfo } = stored;
    return { ...publicInfo, token };
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const { editorConfig, tokens } = await this.readConfig(userId);
    const next = tokens.filter((t) => t.id !== tokenId);
    if (next.length === tokens.length) return false;
    await this.writeTokens(userId, editorConfig, next);
    return true;
  }

  /** Verifies a Basic auth header; returns userId or null. */
  async authenticate(authorization?: string): Promise<string | null> {
    const creds = parseBasicAuth(authorization);
    if (!creds) return null;
    const parsed = parseToken(creds.password);
    if (!parsed) return null;
    const { editorConfig, tokens } = await this.readConfig(parsed.userId);
    const match = tokens.find(
      (t) => t.id === parsed.tokenId && tokenMatches(creds.password, t),
    );
    if (!match) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: parsed.userId },
      select: { id: true, deletedAt: true },
    });
    if (!user || user.deletedAt) return null;

    // Best-effort usage stamp (at most once per hour).
    const last = match.lastUsedAt ? Date.parse(match.lastUsedAt) : 0;
    if (Date.now() - last > 3_600_000) {
      match.lastUsedAt = new Date().toISOString();
      await this.writeTokens(parsed.userId, editorConfig, tokens).catch(
        () => undefined,
      );
    }
    return parsed.userId;
  }

  async resolveRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (member) return member.role as ProjectRole;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { createdById: true },
    });
    return project?.createdById === userId ? 'owner' : null;
  }
}
