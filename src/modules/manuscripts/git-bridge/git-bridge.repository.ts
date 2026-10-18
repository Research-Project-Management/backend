/**
 * git-bridge/git-bridge.repository.ts
 * Direct @Injectable() Repository for Manuscripts Git Bridge.
 *
 * Encapsulates:
 * - Prisma UserSettings Git token storage & ProjectMember role resolution
 * - Bare Git repository management and `git` CLI plumbing subprocesses
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { PrismaService } from '@/core';
import {
  GIT_DEFAULT_BRANCH,
  GitService,
  ProjectRole,
  StoredGitToken,
  IGitAccessRepositoryPort,
  UserEditorGitConfig,
  GitRunResult,
  IGitCliPort,
} from './domain';

export type { GitRunResult };
export const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAIN_REF = `refs/heads/${GIT_DEFAULT_BRANCH}`;

@Injectable()
export class GitCliAdapter implements IGitCliPort {
  private readonly logger = new Logger(GitCliAdapter.name);
  readonly root =
    process.env.GIT_BRIDGE_ROOT || path.join(os.tmpdir(), 'flux-git-bridge');
  private readonly gitBin = process.env.GIT_BINARY || 'git';

  bareDir(projectId: string): string {
    return path.join(this.root, `${projectId}.git`);
  }
  workDir(projectId: string): string {
    return path.join(this.root, `${projectId}.work`);
  }
  private indexFile(projectId: string): string {
    return path.join(this.root, `${projectId}.index`);
  }

  private baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: process.env.GIT_BRIDGE_AUTHOR_NAME || 'Flux',
      GIT_AUTHOR_EMAIL:
        process.env.GIT_BRIDGE_AUTHOR_EMAIL || 'git-bridge@flux.local',
      GIT_COMMITTER_NAME: process.env.GIT_BRIDGE_AUTHOR_NAME || 'Flux',
      GIT_COMMITTER_EMAIL:
        process.env.GIT_BRIDGE_AUTHOR_EMAIL || 'git-bridge@flux.local',
      ...extra,
    };
  }

  private snapshotEnv(projectId: string): NodeJS.ProcessEnv {
    return this.baseEnv({
      GIT_DIR: this.bareDir(projectId),
      GIT_WORK_TREE: this.workDir(projectId),
      GIT_INDEX_FILE: this.indexFile(projectId),
    });
  }

  run(
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; cwd?: string; input?: Buffer } = {},
  ): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBin, args, {
        env: opts.env ?? this.baseEnv(),
        cwd: opts.cwd,
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
      if (opts.input) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  private async runOk(
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; cwd?: string; input?: Buffer } = {},
  ): Promise<Buffer> {
    const r = await this.run(args, opts);
    if (r.code !== 0) {
      throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  async ensureRepo(projectId: string): Promise<void> {
    const bare = this.bareDir(projectId);
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.access(path.join(bare, 'HEAD'));
      return;
    } catch {
      // initialize below
    }
    await this.runOk(['init', '--bare', '--quiet', bare]);
    const env = this.baseEnv({ GIT_DIR: bare });
    await this.runOk(['symbolic-ref', 'HEAD', MAIN_REF], { env });
    for (const [k, v] of [
      ['receive.denyNonFastForwards', 'true'],
      ['receive.denyDeletes', 'true'],
      ['core.autocrlf', 'false'],
      ['uploadpack.allowFilter', 'true'],
    ]) {
      await this.runOk(['config', k, v], { env });
    }
  }

  async resolveRef(projectId: string, ref = MAIN_REF): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', ref], {
      env: this.baseEnv({ GIT_DIR: this.bareDir(projectId) }),
    });
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  }

  async listRefs(projectId: string): Promise<string[]> {
    const r = await this.run(['for-each-ref', '--format=%(refname)'], {
      env: this.baseEnv({ GIT_DIR: this.bareDir(projectId) }),
    });
    return r.stdout
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async deleteRef(projectId: string, ref: string): Promise<void> {
    await this.runOk(['update-ref', '-d', ref], {
      env: this.baseEnv({ GIT_DIR: this.bareDir(projectId) }),
    });
  }

  async setMainRef(
    projectId: string,
    sha: string,
    expectedOld: string | null,
  ): Promise<void> {
    const args = ['update-ref', MAIN_REF, sha];
    if (expectedOld) args.push(expectedOld);
    await this.runOk(args, {
      env: this.baseEnv({ GIT_DIR: this.bareDir(projectId) }),
    });
  }

  async commitSnapshot(
    projectId: string,
    files: Array<{ path: string; content: Buffer }>,
    message: string,
  ): Promise<string> {
    const work = this.workDir(projectId);
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    for (const f of files) {
      const abs = path.join(work, ...f.path.split('/'));
      if (!abs.startsWith(work + path.sep)) {
        throw new Error(`Refusing to write outside work tree: ${f.path}`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content);
    }

    const env = this.snapshotEnv(projectId);
    const parent = await this.resolveRef(projectId);
    await this.runOk(
      parent ? ['read-tree', parent] : ['read-tree', '--empty'],
      {
        env,
      },
    );
    await this.runOk(['add', '-A', '--', '.'], { env, cwd: work });
    const tree = (await this.runOk(['write-tree'], { env }))
      .toString('utf8')
      .trim();

    if (parent) {
      const parentTree = (
        await this.runOk(['rev-parse', `${parent}^{tree}`], { env })
      )
        .toString('utf8')
        .trim();
      if (parentTree === tree) return parent;
    }
    const commitArgs = ['commit-tree', tree, '-m', message];
    if (parent) commitArgs.splice(2, 0, '-p', parent);
    const commit = (await this.runOk(commitArgs, { env }))
      .toString('utf8')
      .trim();
    await this.setMainRef(projectId, commit, parent);
    return commit;
  }

  async advertiseRefs(projectId: string, service: GitService): Promise<Buffer> {
    return this.runOk(
      [
        service.replace(/^git-/, ''),
        '--stateless-rpc',
        '--advertise-refs',
        this.bareDir(projectId),
      ],
      { env: this.baseEnv() },
    );
  }

  serviceRpc(
    projectId: string,
    service: GitService,
    body: Readable,
  ): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.gitBin,
        [
          service.replace(/^git-/, ''),
          '--stateless-rpc',
          this.bareDir(projectId),
        ],
        { env: this.baseEnv(), windowsHide: true },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.stdin.on('error', (e) =>
        this.logger.debug(`git ${service} stdin closed: ${e.message}`),
      );
      body.on('error', (e) => {
        child.kill();
        reject(e);
      });
      child.on('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
      body.pipe(child.stdin);
    });
  }

  async diffNameStatus(
    projectId: string,
    from: string | null,
    to: string,
  ): Promise<string> {
    return (
      await this.runOk(
        [
          'diff',
          '--name-status',
          '-z',
          '--no-renames',
          from || EMPTY_TREE_SHA1,
          to,
        ],
        { env: this.baseEnv({ GIT_DIR: this.bareDir(projectId) }) },
      )
    ).toString('utf8');
  }

  async readBlob(
    projectId: string,
    commit: string,
    repoPath: string,
  ): Promise<Buffer> {
    return this.runOk(['cat-file', 'blob', `${commit}:${repoPath}`], {
      env: this.baseEnv({ GIT_DIR: this.bareDir(projectId) }),
    });
  }
}

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
