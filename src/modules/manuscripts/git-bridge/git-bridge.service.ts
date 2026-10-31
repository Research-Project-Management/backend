/**
 * git-bridge/git-bridge.service.ts
 * Deep Module Service for Manuscripts Git Bridge.
 * Consolidates personal Git token management, HTTP Basic authentication,
 * role authorization, and bidirectional Structure/Docstore/Filestore <-> Git sync.
 */

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  ManuscriptDomainEventBus,
  SagaRunner,
} from '@/modules/manuscripts/core';
import { GitBridgeRepository, GitCliAdapter } from './git-bridge.repository';
import {
  generateToken,
  GIT_DEFAULT_BRANCH,
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

export interface NodeEntryMemento {
  readonly projectPath: string;
  readonly existed: boolean;
  readonly nodeId?: string;
  readonly name?: string;
  readonly parentId?: string | null;
  readonly type?: 'DOC' | 'FILE' | 'FOLDER';
  readonly docId?: string | null;
  readonly fileId?: string | null;
  readonly isRootDoc?: boolean;
  readonly docLines?: string[];
  readonly docVersion?: number;
}

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
  private readonly gitCli: GitCliAdapter;
  private readonly liveCollab: LiveCollaborationPort;
  private readonly domainEventBus: ManuscriptDomainEventBus | null;

  constructor(
    private readonly repository: GitBridgeRepository,
    private readonly docstore: DocstoreService,
    private readonly filestore: FilestoreService,
    private readonly structure: StructureService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional() gitCli?: GitCliAdapter,
    @Optional() domainEventBus?: ManuscriptDomainEventBus,
  ) {
    this.gitCli = gitCli ?? new GitCliAdapter();
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort).flushDocs ===
        'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
    this.domainEventBus = domainEventBus ?? null;
  }

  // ─── Token & Access Management ──────────────────────────────────────────────

  async listTokens(userId: string) {
    const { tokens } = await this.repository.readConfig(userId);
    return tokens.map(({ hash: _hash, ...rest }) => rest);
  }

  /** Returns the plaintext token exactly once. */
  async createToken(userId: string, label?: string) {
    const { editorConfig, tokens } = await this.repository.readConfig(userId);
    if (tokens.length >= MAX_TOKENS) {
      throw new BadRequestException(
        `At most ${MAX_TOKENS} git tokens are allowed`,
      );
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
    return this.gitCli.advertiseRefs(projectId, service);
  }

  serviceRpc(
    projectId: string,
    service: GitService,
    body: Readable,
  ): Promise<GitRunResult> {
    return this.gitCli.serviceRpc(projectId, service, body);
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

  /**
   * Executes git-receive-pack under project lock, prunes non-default branch refs,
   * and applies pushed commits into the manuscript project.
   */
  async handleReceivePack(
    projectId: string,
    requestBody: Readable,
  ): Promise<{ stdout: Buffer } | { rejected: string }> {
    return this.withProjectLock(projectId, async () => {
      const before = await this.materialize(projectId);
      const result = await this.serviceRpc(
        projectId,
        'git-receive-pack',
        requestBody,
      );
      const after = await this.resolveRef(projectId);

      const mainRef = `refs/heads/${GIT_DEFAULT_BRANCH}`;
      const extra = (await this.listRefs(projectId)).filter(
        (r) => r !== mainRef,
      );
      for (const ref of extra) {
        await this.deleteRef(projectId, ref);
      }

      if (after && after !== before) {
        try {
          const applied = await this.applyPush(projectId, before, after);
          this.logger.log(
            `git push ${projectId}: +${applied.created.length} ~${applied.updated.length} -${applied.deleted.length}`,
          );
          await this.materialize(projectId);
        } catch (applyErr) {
          await this.setMainRef(projectId, before, after).catch(
            () => undefined,
          );
          throw applyErr;
        }
      } else if (extra.length > 0 && after === before) {
        return {
          rejected: `Only the '${GIT_DEFAULT_BRANCH}' branch can be pushed`,
        };
      }
      return { stdout: result.stdout };
    });
  }

  private live(): LiveCollaborationPort {
    return this.liveCollab;
  }

  private domainBus(): ManuscriptDomainEventBus | null {
    return this.domainEventBus;
  }

  /** Commits the current project state to `main`; returns tip sha. Caller holds lock. */
  async materialize(projectId: string): Promise<string> {
    await this.gitCli.ensureRepo(projectId);
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
    return this.gitCli.commitSnapshot(
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
    const MAX_PUSH_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB per file limit
    const MAX_PUSH_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB total push limit

    const changes: GitChange[] = parseNameStatusZ(
      await this.gitCli.diffNameStatus(projectId, oldSha, newSha),
    );

    const ordered = [
      ...changes.filter((c) => c.status === 'D'),
      ...changes.filter((c) => c.status !== 'D'),
    ];

    // 1. Pre-validate all paths, read all blobs, and validate sizes before mutating any state
    const stagedChanges: Array<{
      status: GitChange['status'];
      repoPath: string;
      projectPath: string;
      content?: Buffer;
    }> = [];
    let totalBytes = 0;

    for (const change of ordered) {
      const projectPath = toProjectPath(change.path);
      if (change.status === 'D') {
        stagedChanges.push({
          status: 'D',
          repoPath: change.path,
          projectPath,
        });
        continue;
      }

      const content = await this.gitCli.readBlob(
        projectId,
        newSha,
        change.path,
      );
      if (content.length > MAX_PUSH_FILE_SIZE_BYTES) {
        throw new PayloadTooLargeException(
          `File "${projectPath}" exceeds maximum permitted push size of 50MB (${content.length} bytes)`,
        );
      }
      totalBytes += content.length;
      if (totalBytes > MAX_PUSH_TOTAL_BYTES) {
        throw new PayloadTooLargeException(
          `Push payload exceeds maximum permitted total size of 200MB`,
        );
      }
      stagedChanges.push({
        status: change.status,
        repoPath: change.path,
        projectPath,
        content,
      });
    }

    // 2. Flush active live Yjs docs before capturing Memento / applying push mutations
    const live = this.live();
    if (live && typeof this.structure.getAllNodes === 'function') {
      const allNodes = await this.structure
        .getAllNodes(projectId)
        .catch(() => []);
      const activeDocIds = allNodes
        .filter((n) => n.docId)
        .map((n) => n.docId as string);
      if (activeDocIds.length > 0) {
        await live.flushDocs(projectId, activeDocIds).catch(() => []);
      }
    }

    // 3. Capture pre-push Memento of affected nodes/docs and execute via SagaRunner
    const mementos = new Map<string, NodeEntryMemento>();
    for (const item of stagedChanges) {
      if (mementos.has(item.projectPath)) continue;
      const memento = await this.captureEntryMemento(
        projectId,
        item.projectPath,
      );
      mementos.set(item.projectPath, memento);
    }

    const result: PushApplyResult = { created: [], updated: [], deleted: [] };
    const saga = new SagaRunner({
      logger: this.logger,
      contextName: `GitBridgeService.applyPush(${projectId})`,
    });

    try {
      for (const item of stagedChanges) {
        const memento = mementos.get(item.projectPath)!;
        await saga.step(
          `applyPush:${item.status}:${item.projectPath}`,
          async () => {
            if (item.status === 'D') {
              if (await this.removeEntry(projectId, item.projectPath)) {
                result.deleted.push(item.projectPath);
              }
              return;
            }
            const outcome = await this.upsertEntry(
              projectId,
              item.projectPath,
              item.content!,
            );
            result[outcome].push(item.projectPath);
          },
          async () => {
            await this.restoreEntryMemento(projectId, memento);
          },
        );
      }
      return result;
    } catch (err) {
      await saga.compensateAll();
      throw err;
    }
  }

  /**
   * Memento Pattern: Captures the pre-mutation state of a project node/document.
   */
  private async captureEntryMemento(
    projectId: string,
    projectPath: string,
  ): Promise<NodeEntryMemento> {
    const existing = await this.structure
      .getNodeByPath(projectId, projectPath)
      .catch(() => null);
    if (!existing) {
      return {
        projectPath,
        existed: false,
      };
    }

    let docLines: string[] | undefined;
    let docVersion: number | undefined;
    if (existing.docId) {
      const doc = await this.docstore
        .getDoc(projectId, existing.docId)
        .catch(() => null);
      if (doc) {
        docLines = doc.lines ? [...doc.lines] : [''];
        docVersion = doc.version;
      }
    }

    return {
      projectPath,
      existed: true,
      nodeId: existing.id,
      name: existing.name,
      parentId: existing.parentId ?? null,
      type: existing.type,
      docId: existing.docId ?? null,
      fileId: existing.fileId ?? null,
      isRootDoc: existing.isRootDoc,
      docLines,
      docVersion,
    };
  }

  /**
   * Memento Compensation: Restores a node/document to its captured pre-push Memento.
   */
  private async restoreEntryMemento(
    projectId: string,
    snap: NodeEntryMemento,
  ): Promise<void> {
    let current = await this.structure
      .getNodeByPath(projectId, snap.projectPath)
      .catch(() => null);

    if (!snap.existed) {
      if (current) {
        await this.removeEntry(projectId, snap.projectPath).catch(
          () => undefined,
        );
      }
      return;
    }

    // If a failed upsert replaced the original node with a different node/doc/file at the same path,
    // remove the newly created replacement before restoring the original Memento state.
    if (
      current &&
      (current.id !== snap.nodeId ||
        (current.docId ?? null) !== (snap.docId ?? null) ||
        (current.fileId ?? null) !== (snap.fileId ?? null))
    ) {
      await this.removeEntry(projectId, snap.projectPath).catch(
        () => undefined,
      );
      current = null;
    }

    if (snap.fileId) {
      await this.filestore
        .restoreFile?.(projectId, snap.fileId)
        ?.catch(() => false);
    }

    if (snap.docId) {
      await this.docstore
        .patchDoc?.(projectId, snap.docId, { deleted: false })
        ?.catch(() => undefined);
      if (snap.docLines) {
        await this.docstore
          .updateDoc(projectId, snap.docId, {
            lines: snap.docLines,
            version: (snap.docVersion ?? 0) + 1,
          })
          .catch(() => undefined);
        const bus = this.domainBus();
        if (bus) {
          await bus.publish({
            type: 'manuscript.document.mutated',
            projectId,
            docId: snap.docId,
            lines: snap.docLines,
            version: (snap.docVersion ?? 0) + 1,
            source: 'git-bridge',
            occurredAt: Date.now(),
          });
        } else {
          await this.live()
            .applyExternalText(
              projectId,
              snap.docId,
              snap.docLines.join('\n'),
            )
            .catch(() => false);
        }
      }
    }

    if (!current && snap.name && snap.type && snap.type !== 'FOLDER') {
      const recreated = await this.structure
        .createNode(projectId, {
          name: snap.name,
          path: snap.projectPath,
          parentId: snap.parentId ?? null,
          type: snap.type,
          docId: snap.docId ?? undefined,
          fileId: snap.fileId ?? undefined,
          isRootDoc: snap.isRootDoc,
        })
        .catch(() => null);
      if (recreated && snap.isRootDoc) {
        await this.structure
          .setRootDoc(projectId, recreated.id)
          .catch(() => undefined);
      }
    }
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
      const bus = this.domainBus();
      if (bus) {
        await bus.publish({
          type: 'manuscript.document.mutated',
          projectId,
          docId: existing.docId,
          lines,
          version: (current.version ?? 0) + 1,
          source: 'git-bridge',
          occurredAt: Date.now(),
        });
      } else {
        await this.live()
          ?.applyExternalText(projectId, existing.docId, lines.join('\n'))
          .catch(() => false);
      }
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
      const lines = splitLines(content.toString('utf8'));
      const doc = await this.docstore.createDoc(projectId, {
        path: projectPath,
        lines,
      });
      const createdDocId = doc.id ?? doc._id;
      await this.structure.createNode(projectId, {
        name,
        parentId: parent?.id ?? null,
        type: 'DOC',
        docId: createdDocId,
      });
      const bus = this.domainBus();
      if (bus && createdDocId) {
        await bus.publish({
          type: 'manuscript.document.mutated',
          projectId,
          docId: createdDocId,
          lines,
          version: doc.version ?? 1,
          source: 'git-bridge',
          occurredAt: Date.now(),
        });
      }
    } else {
      const relativeFilePath = projectPath.replace(/^\/+/, '') || name;
      const file = await this.filestore.uploadFileFromBuffer(
        projectId,
        relativeFilePath,
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
