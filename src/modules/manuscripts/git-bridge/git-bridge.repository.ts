/**
 * git-bridge/git-bridge.repository.ts
 * Direct @Injectable() Repository for Manuscripts Git Bridge.
 *
 * Encapsulates:
 * - Prisma UserSettings Git token storage & ProjectMember role resolution
 * - Bare Git repository management and `git` CLI plumbing subprocesses
 */

import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '@/core';
import {
  GitService,
  ProjectRole,
  StoredGitToken,
} from './domain/git-bridge.domain';
import {
  IGitAccessRepositoryPort,
  UserEditorGitConfig,
} from './core/ports/git-access-repository.port';
import { GitRunResult, IGitCliPort } from './core/ports/git-cli.port';
import { GitCliAdapter } from './core/adapters/git-cli.adapter';

@Injectable()
export class GitBridgeRepository
  implements IGitAccessRepositoryPort, IGitCliPort
{
  private readonly gitCli: IGitCliPort;

  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    gitCliOverride?: GitCliAdapter,
  ) {
    this.gitCli = gitCliOverride ?? new GitCliAdapter();
  }

  // ─── Prisma Access Token & Role Persistence ─────────────────────────────────

  async readConfig(userId: string): Promise<UserEditorGitConfig> {
    if (!this.prisma) {
      return { editorConfig: {}, tokens: [] };
    }
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { editorConfig: true },
    });
    const editorConfig = (row?.editorConfig as Record<string, unknown>) || {};
    const tokens: StoredGitToken[] = Array.isArray(editorConfig.gitTokens)
      ? (editorConfig.gitTokens as StoredGitToken[])
      : [];
    return { editorConfig, tokens };
  }

  async writeTokens(
    userId: string,
    editorConfig: Record<string, unknown>,
    tokens: StoredGitToken[],
  ): Promise<void> {
    if (!this.prisma) return;
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

  async isActiveUser(userId: string): Promise<boolean> {
    if (!this.prisma) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true },
    });
    return Boolean(user && !user.deletedAt);
  }

  async resolveProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    if (!this.prisma) return null;
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (member) return member.role;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { createdById: true },
    });
    return project?.createdById === userId ? 'owner' : null;
  }

  // ─── Bare Git Repository & CLI Plumbing ─────────────────────────────────────

  bareDir(projectId: string): string {
    return this.gitCli.bareDir(projectId);
  }

  workDir(projectId: string): string {
    return this.gitCli.workDir(projectId);
  }

  run(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; cwd?: string; input?: Buffer },
  ): Promise<GitRunResult> {
    return this.gitCli.run(args, opts);
  }

  ensureRepo(projectId: string): Promise<void> {
    return this.gitCli.ensureRepo(projectId);
  }

  resolveRef(projectId: string, ref?: string): Promise<string | null> {
    return this.gitCli.resolveRef(projectId, ref);
  }

  listRefs(projectId: string): Promise<string[]> {
    return this.gitCli.listRefs(projectId);
  }

  deleteRef(projectId: string, ref: string): Promise<void> {
    return this.gitCli.deleteRef(projectId, ref);
  }

  setMainRef(
    projectId: string,
    sha: string,
    expectedOld: string | null,
  ): Promise<void> {
    return this.gitCli.setMainRef(projectId, sha, expectedOld);
  }

  commitSnapshot(
    projectId: string,
    files: Array<{ path: string; content: Buffer }>,
    message: string,
  ): Promise<string> {
    return this.gitCli.commitSnapshot(projectId, files, message);
  }

  advertiseRefs(projectId: string, service: GitService): Promise<Buffer> {
    return this.gitCli.advertiseRefs(projectId, service);
  }

  serviceRpc(
    projectId: string,
    service: GitService,
    body: Readable,
  ): Promise<GitRunResult> {
    return this.gitCli.serviceRpc(projectId, service, body);
  }

  diffNameStatus(
    projectId: string,
    from: string | null,
    to: string,
  ): Promise<string> {
    return this.gitCli.diffNameStatus(projectId, from, to);
  }

  readBlob(
    projectId: string,
    commit: string,
    repoPath: string,
  ): Promise<Buffer> {
    return this.gitCli.readBlob(projectId, commit, repoPath);
  }
}
