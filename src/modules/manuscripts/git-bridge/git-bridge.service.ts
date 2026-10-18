/**
 * git-bridge/git-bridge.service.ts
 * Deep Module Service for Manuscripts Git Bridge.
 * Consolidates personal Git token management, HTTP Basic authentication,
 * role authorization, and bidirectional Structure/Docstore/Filestore <-> Git sync.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Readable } from 'stream';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import { GitBridgeRepository } from './git-bridge.repository';
import {
  generateToken,
  GitChange,
  GitRunResult,
  GitService,
  isTextPath,
  parseBasicAuth,
  parseNameStatusZ,
  parseToken,
  ProjectRole,
  PushApplyResult,
  StoredGitToken,
  tokenMatches,
  toProjectPath,
  toRepoPath,
} from './domain';

const MAX_TOKENS = 20;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

function splitLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
}

@Injectable()
export class GitBridgeService {
  private readonly logger = new Logger(GitBridgeService.name);
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repository: GitBridgeRepository,
    private readonly docstore: DocstoreService,
    private readonly filestore: FilestoreService,
    private readonly structure: StructureService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  // ─── Token & Access Management ──────────────────────────────────────────────

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

  // ─── Git Smart-HTTP & Synchronization ───────────────────────────────────────

  /** Serializes all repo operations per project (in-process mutex). */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
  }

  advertiseRefs(projectId: string, service: GitService): Promise<Buffer> {
    return this.repository.advertiseRefs(projectId, service);
  }

  serviceRpc(
    projectId: string,
    service: GitService,
    body: Readable,
  ): Promise<GitRunResult> {
    return this.repository.serviceRpc(projectId, service, body);
  }

  resolveRef(projectId: string, ref?: string): Promise<string | null> {
    return this.repository.resolveRef(projectId, ref);
  }

  listRefs(projectId: string): Promise<string[]> {
    return this.repository.listRefs(projectId);
  }

  deleteRef(projectId: string, ref: string): Promise<void> {
    return this.repository.deleteRef(projectId, ref);
  }

  setMainRef(
    projectId: string,
    sha: string,
    expectedOld: string | null,
  ): Promise<void> {
    return this.repository.setMainRef(projectId, sha, expectedOld);
  }

  private live(): LiveCollaborationPort | null {
    try {
      return (
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null
      );
    } catch {
      return null;
    }
  }

  /** Commits the current project state to `main`; returns tip sha. Caller holds lock. */
  async materialize(projectId: string): Promise<string> {
    await this.repository.ensureRepo(projectId);
    const nodes = await this.structure.getAllNodes(projectId);

    const live = this.live();
    if (live) {
      const docIds = nodes.filter((n) => n.docId).map((n) => n.docId as string);
      await live
        .flushDocs(projectId, docIds)
        .catch((e) =>
          this.logger.warn(
            `Live flush before git snapshot failed: ${e?.message}`,
          ),
        );
    }

    const files: Array<{ path: string; content: Buffer }> = [];
    for (const node of nodes) {
      if (node.type === 'FOLDER' || node.path === '/') continue;
      const repoPath = toRepoPath(node.path);
      if (node.docId) {
        try {
          const doc = await this.docstore.getDoc(projectId, node.docId);
          if (doc.deleted) continue;
          files.push({
            path: repoPath,
            content: Buffer.from((doc.lines || []).join('\n'), 'utf8'),
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Skipping doc ${node.path}: ${msg}`);
        }
      } else if (node.fileId) {
        try {
          const { stream } = await this.filestore.openReadStream(
            projectId,
            node.fileId,
          );
          files.push({ path: repoPath, content: await streamToBuffer(stream) });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Skipping file ${node.path}: ${msg}`);
        }
      }
    }
    return this.repository.commitSnapshot(
      projectId,
      files,
      `Flux snapshot ${new Date().toISOString()}`,
    );
  }

  /** Applies the tree diff old..new into the project. Caller holds lock. */
  async applyPush(
    projectId: string,
    oldSha: string | null,
    newSha: string,
  ): Promise<PushApplyResult> {
    const changes: GitChange[] = parseNameStatusZ(
      await this.repository.diffNameStatus(projectId, oldSha, newSha),
    );
    for (const c of changes) toProjectPath(c.path);

    const result: PushApplyResult = { created: [], updated: [], deleted: [] };
    const ordered = [
      ...changes.filter((c) => c.status === 'D'),
      ...changes.filter((c) => c.status !== 'D'),
    ];
    for (const change of ordered) {
      const projectPath = toProjectPath(change.path);
      if (change.status === 'D') {
        if (await this.removeEntry(projectId, projectPath)) {
          result.deleted.push(projectPath);
        }
        continue;
      }
      const content = await this.repository.readBlob(
        projectId,
        newSha,
        change.path,
      );
      const outcome = await this.upsertEntry(projectId, projectPath, content);
      result[outcome].push(projectPath);
    }
    return result;
  }

  private async removeEntry(
    projectId: string,
    projectPath: string,
  ): Promise<boolean> {
    const node = await this.structure.getNodeByPath(projectId, projectPath);
    if (!node) return false;
    if (node.docId) {
      await this.docstore.patchDoc(projectId, node.docId, { deleted: true });
    }
    if (node.fileId) {
      await this.filestore.deleteFile(projectId, node.fileId, false);
    }
    await this.structure.deleteNode(projectId, node.id);
    return true;
  }

  private async upsertEntry(
    projectId: string,
    projectPath: string,
    content: Buffer,
  ): Promise<'created' | 'updated'> {
    const asText = isTextPath(projectPath, content);
    const existing = await this.structure.getNodeByPath(projectId, projectPath);

    if (existing?.docId && asText) {
      const lines = splitLines(content.toString('utf8'));
      const current = await this.docstore.getDoc(projectId, existing.docId);
      await this.docstore.updateDoc(projectId, existing.docId, {
        lines,
        version: (current.version ?? 0) + 1,
      });
      await this.live()
        ?.applyExternalText(projectId, existing.docId, lines.join('\n'))
        .catch(() => false);
      return 'updated';
    }

    let outcome: 'created' | 'updated' = 'created';
    if (existing) {
      await this.removeEntry(projectId, projectPath);
      outcome = 'updated';
    }

    const name = projectPath.split('/').pop() as string;
    const dir =
      projectPath.slice(0, projectPath.length - name.length - 1) || '/';
    const parent =
      dir === '/' ? null : await this.structure.mkdirp(projectId, dir);

    if (asText) {
      const doc = await this.docstore.createDoc(projectId, {
        path: projectPath,
        lines: splitLines(content.toString('utf8')),
      });
      await this.structure.createNode(projectId, {
        name,
        parentId: parent?.id ?? null,
        type: 'DOC',
        docId: doc.id ?? doc._id,
      });
    } else {
      const file = await this.filestore.uploadFileFromBuffer(
        projectId,
        name,
        content,
      );
      await this.structure.createNode(projectId, {
        name,
        parentId: parent?.id ?? null,
        type: 'FILE',
        fileId: file.id,
      });
    }
    return outcome;
  }
}
