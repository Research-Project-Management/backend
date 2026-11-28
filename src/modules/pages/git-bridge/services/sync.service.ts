/**
 * git-bridge/services/sync.service.ts
 * GoF Facade + Lock Decorator (`withLock`) + Data-Driven Strategy (`createStrategies`)
 * + Memento (`EntryMemento`) + Saga Compensation (`SagaRunner`).
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable, Writable } from 'node:stream';
import { DistributedLockService, mapWithConcurrency } from '@/core';
import {
  isTextPath,
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  PageDomainEventBus,
  SagaRunner,
  UserResolverService,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import { FilestoreService } from '@/modules/pages/filestore';
import { SnapshotService } from '@/modules/pages/history';
import { StructureService } from '@/modules/pages/structure';
import { PackAdapter } from '../adapters/pack.adapter';
import { BlobEntry, GitAuthor, RepoAdapter } from '../adapters/repo.adapter';
import { GitBridgeRepository } from '../git-bridge.repository';
import { GitBridgeError } from '../domain/errors';
import {
  DEFAULT_BRANCH,
  GC_THRESHOLD,
  GitService,
  MAIN_REF,
  RepoPathVo,
} from '../domain/policy';
import {
  hasSideband,
  PktReportBuilder,
  splitLines,
} from '../domain/pack.domain';

const FILE_CONCURRENCY = 8;
const LOCK_TTL_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export interface PushSummary {
  readonly created: string[];
  readonly updated: string[];
  readonly deleted: string[];
}

interface DocSnapshot {
  readonly lines: string[];
  readonly version: number;
  readonly deleted: boolean;
}

/**
 * GoF Memento Value Object capturing pre-push state of a virtual tree node/document.
 */
export class EntryMemento {
  private constructor(
    public readonly path: RepoPathVo,
    public readonly existed: boolean,
    public readonly nodeId?: string,
    public readonly type?: 'DOC' | 'FILE' | 'FOLDER',
    public readonly parentId?: string | null,
    public readonly docId?: string | null,
    public readonly fileId?: string | null,
    public readonly isRoot?: boolean,
    public readonly lines?: string[],
    public readonly version?: number,
  ) {}

  public static empty(path: RepoPathVo): EntryMemento {
    return new EntryMemento(path, false);
  }

  public static capture(
    path: RepoPathVo,
    node: {
      id: string;
      type: 'DOC' | 'FILE' | 'FOLDER';
      parentId?: string | null;
      docId?: string | null;
      fileId?: string | null;
      isRootDoc?: boolean;
    },
    doc?: { lines?: string[]; version?: number } | null,
  ): EntryMemento {
    return new EntryMemento(
      path,
      true,
      node.id,
      node.type,
      node.parentId ?? null,
      node.docId ?? null,
      node.fileId ?? null,
      node.isRootDoc,
      doc?.lines ? [...doc.lines] : undefined,
      doc?.version,
    );
  }
}

interface UpsertCtx {
  readonly spaceId: string;
  readonly pageId?: string;
  readonly path: RepoPathVo;
  readonly parentId: string | null;
  readonly content: Buffer;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly live: LiveCollaborationPort;
  private readonly eventBus: PageDomainEventBus;

  /** GoF Data-Driven Strategy Map dispatching text (`doc`) vs binary (`file`) creation. */
  private readonly createStrategies: Record<
    'doc' | 'file',
    (ctx: UpsertCtx) => Promise<void>
  >;

  constructor(
    private readonly repo: GitBridgeRepository,
    private readonly gitRepo: RepoAdapter,
    private readonly pack: PackAdapter,
    private readonly docstore: DocstoreService,
    private readonly filestore: FilestoreService,
    private readonly structure: StructureService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() eventBus?: PageDomainEventBus,
    @Optional() private readonly distLock?: DistributedLockService,
    @Optional() private readonly snapshots?: SnapshotService,
    @Optional() private readonly users?: UserResolverService,
  ) {
    this.live = liveCollab ?? NOOP_LIVE_COLLABORATION;
    this.eventBus = eventBus ?? new PageDomainEventBus(this.live);

    this.createStrategies = {
      doc: async ({ spaceId, pageId, path, parentId, content }) => {
        const lines = splitLines(content.toString('utf8'));
        const doc = await this.docstore.createDoc(spaceId, {
          path: path.project,
          lines,
          pageId,
        });
        await this.structure.createNode(
          spaceId,
          { name: path.name, parentId, type: 'DOC', docId: doc._id, pageId },
          pageId,
        );
        await this.publishDocChange(spaceId, doc._id, lines, doc.version ?? 1);
      },
      file: async ({ spaceId, pageId, path, parentId, content }) => {
        const file = await this.filestore.uploadFileFromBuffer(
          spaceId,
          path.repo,
          content,
          undefined,
          {
            syncStructureNode: false,
            ...(pageId ? { pageId } : {}),
          },
        );
        await this.structure.createNode(
          spaceId,
          { name: path.name, parentId, type: 'FILE', fileId: file.id, pageId },
          pageId,
        );
      },
    };
  }

  // ─── GoF Decorator + Template Method: Two-Tier Repository Mutex ─────────────

  public withLock<T>(repoId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(repoId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.acquireClusterLock(repoId, task));
    const tail = next.catch(() => undefined);
    this.queues.set(repoId, tail);
    void tail.then(() => {
      if (this.queues.get(repoId) === tail) this.queues.delete(repoId);
    });
    return next;
  }

  private async acquireClusterLock<T>(
    repoId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!this.distLock) return task();

    const key = `git-repo:${repoId}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let waitMs = 60;

    while (Date.now() < deadline) {
      let executed = false;
      let out!: T;

      await this.distLock.withLock(key, LOCK_TTL_MS, async ({ heartbeat }) => {
        executed = true;
        const timer = setInterval(() => {
          void heartbeat().catch(() => false);
        }, HEARTBEAT_MS);
        timer.unref?.();
        try {
          out = await task();
        } finally {
          clearInterval(timer);
        }
      });

      if (executed) return out;
      await new Promise((r) => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 2, 500);
    }

    throw new GitBridgeError(
      'Repository is busy with another Git operation; please retry.',
      'GIT_REPO_BUSY',
      429,
    );
  }

  // ─── Smart-HTTP Facade Operations ───────────────────────────────────────────

  public advertiseRefs(repoId: string, service: GitService): Promise<Buffer> {
    return this.withLock(repoId, async () => {
      await this.materialize(repoId);
      return this.pack.advertiseRefs(repoId, service);
    });
  }

  public streamUpload(
    repoId: string,
    input: Readable,
    output: Writable,
    onFirstByte: () => void,
  ): Promise<void> {
    return this.withLock(repoId, async () => {
      await this.materialize(repoId);
      await this.pack.streamUpload(repoId, input, output, onFirstByte);
    });
  }

  public receivePush(
    repoId: string,
    userId: string,
    input: Readable,
  ): Promise<{ stdout: Buffer }> {
    return this.withLock(repoId, async () => {
      const oldSha = await this.materialize(repoId);
      const rpc = await this.pack.receivePack(repoId, input);
      const sideband = hasSideband(rpc.stdout);

      const extraRefs = (await this.gitRepo.listRefs(repoId)).filter(
        (r) => r !== MAIN_REF,
      );
      for (const ref of extraRefs) {
        await this.gitRepo.deleteRef(repoId, ref);
      }

      const newSha = await this.gitRepo.resolveRef(repoId);

      if (!newSha) {
        await this.gitRepo.setMainRef(repoId, oldSha);
        return {
          stdout: PktReportBuilder.reject(
            `Deleting branch '${DEFAULT_BRANCH}' is not permitted`,
            { sideband },
          ),
        };
      }

      if (newSha === oldSha) {
        if (extraRefs.length > 0) {
          return {
            stdout: PktReportBuilder.reject(
              `Only the '${DEFAULT_BRANCH}' branch can be pushed`,
              { sideband },
            ),
          };
        }
        return { stdout: rpc.stdout };
      }

      if (oldSha && !(await this.gitRepo.isAncestor(repoId, oldSha, newSha))) {
        await this.gitRepo.setMainRef(repoId, oldSha);
        return {
          stdout: PktReportBuilder.reject(
            'Non-fast-forward push rejected; pull latest changes first',
            { sideband },
          ),
        };
      }

      try {
        const res = await this.applyPush(repoId, oldSha, newSha, userId);
        this.logger.log(
          `git push ${repoId} (${newSha.slice(0, 7)}): +${res.created.length} ~${res.updated.length} -${res.deleted.length}`,
        );
        return { stdout: rpc.stdout };
      } catch (err: unknown) {
        await this.gitRepo.setMainRef(repoId, oldSha).catch(() => undefined);
        if (err instanceof GitBridgeError) {
          return {
            stdout: PktReportBuilder.reject(err.message, { sideband }),
          };
        }
        throw err;
      }
    });
  }

  // ─── Worktree-Free Materialize ($O(\Delta)$) ────────────────────────────────

  public async materialize(repoId: string): Promise<string> {
    await this.gitRepo.ensureBare(repoId);
    const { spaceId, pageId, ownerId } = await this.repo.resolveTarget(repoId);
    const nodes = await this.structure.getAllNodes(spaceId, undefined, pageId);

    await this.flushLiveDocs(spaceId, nodes);
    const docs = await this.prefetchDocs(spaceId, pageId);

    const leaves = nodes.filter((n) => n.type !== 'FOLDER' && n.path !== '/');
    const items = await mapWithConcurrency(
      leaves,
      FILE_CONCURRENCY,
      async (node): Promise<BlobEntry | null> => {
        let pathVo: RepoPathVo;
        try {
          pathVo = RepoPathVo.fromProject(node.path);
        } catch {
          return null;
        }

        if (node.docId) {
          const doc = docs.get(node.docId);
          if (!doc || doc.deleted) return null;
          return {
            path: pathVo,
            content: Buffer.from(doc.lines.join('\n'), 'utf8'),
          };
        }

        if (node.fileId) {
          try {
            const { stream } = await this.filestore.openReadStream(
              spaceId,
              node.fileId,
            );
            return { path: pathVo, content: await readStream(stream) };
          } catch {
            return null;
          }
        }
        return null;
      },
    );

    const files = items.filter((f): f is BlobEntry => f !== null);
    const author = await this.resolveAuthor(ownerId);
    const { headOid, treeOid } = await this.gitRepo.commitTree(
      repoId,
      files,
      'Update on Flux',
      author,
    );
    if (pageId) {
      await this.repo
        .upsertRepoState(pageId, headOid, treeOid)
        .catch(() => undefined);
    }
    return headOid;
  }

  // ─── Push Application + Memento Saga + History Integration ──────────────────

  public async applyPush(
    repoId: string,
    oldSha: string | null,
    newSha: string,
    userId?: string,
  ): Promise<PushSummary> {
    const diff = await this.gitRepo.diffCommits(repoId, oldSha, newSha);
    if (diff.entries.length === 0) {
      this.gitRepo.recordPush(repoId, newSha, diff.treeOid);
      return { created: [], updated: [], deleted: [] };
    }

    const { spaceId, pageId } = await this.repo.resolveTarget(repoId);
    const nodes = await this.structure
      .getAllNodes(spaceId, undefined, pageId)
      .catch(() => []);
    await this.flushLiveDocs(spaceId, nodes);
    const docs = await this.prefetchDocs(spaceId, pageId);

    const uniquePaths = new Map<string, RepoPathVo>();
    for (const e of diff.entries) uniquePaths.set(e.path.project, e.path);

    const captured = await Promise.all(
      Array.from(uniquePaths.values()).map((p) =>
        this.captureMemento(spaceId, pageId, p, docs),
      ),
    );
    const mementos = new Map<string, EntryMemento>(
      captured.map((m) => [m.path.project, m]),
    );

    const dirIds = new Map<string, string | null>([['/', null]]);
    for (const n of nodes) {
      if (n.type === 'FOLDER' && n.path) dirIds.set(n.path, n.id);
    }

    const summary: PushSummary = { created: [], updated: [], deleted: [] };
    const saga = new SagaRunner({
      logger: this.logger,
      contextName: `SyncService.applyPush(${repoId})`,
    });

    try {
      for (const item of diff.entries) {
        const snap = mementos.get(item.path.project)!;
        await saga.step(
          `${item.status}:${item.path.project}`,
          async () => {
            if (item.status === 'D') {
              if (await this.deleteEntry(spaceId, pageId, item.path)) {
                summary.deleted.push(item.path.project);
              }
              return;
            }
            const kind = await this.upsertEntry(
              spaceId,
              pageId,
              item.path,
              item.content!,
              dirIds,
              docs,
            );
            summary[kind].push(item.path.project);
          },
          async () => {
            await this.restoreMemento(spaceId, pageId, snap);
          },
        );
      }
    } catch (err) {
      await saga.compensateAll();
      throw err;
    }

    this.gitRepo.recordPush(repoId, newSha, diff.treeOid);
    const snapshotId = await this.recordHistory(
      spaceId,
      pageId,
      newSha,
      diff.message,
      userId,
    );

    if (pageId) {
      const subject = diff.message.split('\n')[0]?.trim().slice(0, 255) || null;
      const gcCount = await this.repo
        .recordPushTransition({
          pageId,
          pusherId: userId ?? null,
          snapshotId,
          beforeOid: oldSha,
          afterOid: newSha,
          rootTreeOid: diff.treeOid,
          commitSubject: subject,
          addedCount: summary.created.length,
          modifiedCount: summary.updated.length,
          deletedCount: summary.deleted.length,
          totalBytes: diff.totalBytes,
        })
        .catch(() => 0);

      if (gcCount >= GC_THRESHOLD) {
        void this.pack
          .runGc(repoId)
          .then(() => this.repo.resetGcPushCount(pageId));
      }
    }

    return summary;
  }

  private async captureMemento(
    spaceId: string,
    pageId: string | undefined,
    path: RepoPathVo,
    docs: Map<string, DocSnapshot>,
  ): Promise<EntryMemento> {
    const node = await this.findNode(spaceId, pageId, path.project);
    if (!node) return EntryMemento.empty(path);
    const doc = node.docId ? (docs.get(node.docId) ?? null) : null;
    return EntryMemento.capture(path, node, doc);
  }

  private async restoreMemento(
    spaceId: string,
    pageId: string | undefined,
    snap: EntryMemento,
  ): Promise<void> {
    let cur = await this.findNode(spaceId, pageId, snap.path.project);

    if (!snap.existed) {
      if (cur) {
        await this.deleteEntry(spaceId, pageId, snap.path).catch(() => false);
      }
      return;
    }

    if (
      cur &&
      (cur.id !== snap.nodeId ||
        (cur.docId ?? null) !== (snap.docId ?? null) ||
        (cur.fileId ?? null) !== (snap.fileId ?? null))
    ) {
      await this.deleteEntry(spaceId, pageId, snap.path).catch(() => false);
      cur = null;
    }

    if (snap.fileId) {
      await this.filestore.restoreFile(spaceId, snap.fileId).catch(() => false);
    }

    if (snap.docId) {
      await this.docstore
        .patchDoc(spaceId, snap.docId, { deleted: false })
        .catch(() => undefined);
      if (snap.lines) {
        const rev = (snap.version ?? 0) + 1;
        await this.docstore
          .updateDoc(spaceId, snap.docId, { lines: snap.lines, version: rev })
          .catch(() => undefined);
        await this.publishDocChange(spaceId, snap.docId, snap.lines, rev);
      }
    }

    if (!cur && snap.type && snap.type !== 'FOLDER') {
      const recreated = await this.structure
        .createNode(
          spaceId,
          {
            name: snap.path.name,
            path: snap.path.project,
            parentId: snap.parentId ?? null,
            type: snap.type,
            docId: snap.docId ?? undefined,
            fileId: snap.fileId ?? undefined,
            isRootDoc: snap.isRoot,
            pageId,
          },
          pageId,
        )
        .catch(() => null);

      if (recreated && snap.isRoot) {
        await this.structure
          .setRootDoc(spaceId, recreated.id)
          .catch(() => undefined);
      }
    }
  }

  private async deleteEntry(
    spaceId: string,
    pageId: string | undefined,
    path: RepoPathVo,
  ): Promise<boolean> {
    const node = await this.findNode(spaceId, pageId, path.project);
    if (!node) return false;
    try {
      await this.structure.deleteNode(spaceId, node.id);
    } catch (err: unknown) {
      const status =
        (err as { status?: number; statusCode?: number })?.status ??
        (err as { status?: number; statusCode?: number })?.statusCode;
      if (
        status === 404 ||
        (err instanceof Error && err.name === 'NodeNotFoundError')
      ) {
        return true;
      }
      throw err;
    }
    return true;
  }

  private async upsertEntry(
    spaceId: string,
    pageId: string | undefined,
    path: RepoPathVo,
    content: Buffer,
    dirIds: Map<string, string | null>,
    docs: Map<string, DocSnapshot>,
  ): Promise<'created' | 'updated'> {
    const isText = isTextPath(path.project, content);
    const existing = await this.findNode(spaceId, pageId, path.project);

    if (existing?.docId && isText) {
      const lines = splitLines(content.toString('utf8'));
      const baseRev = docs.get(existing.docId)?.version ?? 0;
      const nextRev = baseRev + 1;
      await this.docstore.updateDoc(spaceId, existing.docId, {
        lines,
        version: nextRev,
      });
      await this.publishDocChange(spaceId, existing.docId, lines, nextRev);
      return 'updated';
    }

    let kind: 'created' | 'updated' = 'created';
    if (existing) {
      await this.deleteEntry(spaceId, pageId, path);
      kind = 'updated';
    }

    const parentId = await this.ensureDir(spaceId, pageId, path.dir, dirIds);
    await this.createStrategies[isText ? 'doc' : 'file']({
      spaceId,
      pageId,
      path,
      parentId,
      content,
    });
    return kind;
  }

  private findNode(spaceId: string, pageId: string | undefined, p: string) {
    return this.structure.getNodeByPath(spaceId, p, pageId).catch(() => null);
  }

  private async ensureDir(
    spaceId: string,
    pageId: string | undefined,
    dir: string,
    dirIds: Map<string, string | null>,
  ): Promise<string | null> {
    if (dir === '/') return null;
    if (dirIds.has(dir)) return dirIds.get(dir) ?? null;
    const folder = await this.structure.mkdirp(spaceId, dir, pageId);
    const id = folder?.id ?? null;
    dirIds.set(dir, id);
    return id;
  }

  private async flushLiveDocs(
    spaceId: string,
    nodes: Array<{ docId?: string | null }>,
  ): Promise<void> {
    const ids = nodes.filter((n) => Boolean(n.docId)).map((n) => n.docId!);
    if (ids.length === 0) return;
    await this.live.flushDocs(spaceId, ids).catch(() => []);
  }

  private async prefetchDocs(
    spaceId: string,
    pageId?: string,
  ): Promise<Map<string, DocSnapshot>> {
    const map = new Map<string, DocSnapshot>();
    const list = await this.docstore
      .getAllDocs(spaceId, pageId)
      .catch(() => []);
    for (const doc of list) {
      if (doc._id) {
        map.set(doc._id, {
          lines: doc.lines || [],
          version: doc.version ?? 1,
          deleted: Boolean(doc.deleted),
        });
      }
    }
    return map;
  }

  private async resolveAuthor(
    userId?: string | null,
  ): Promise<Partial<GitAuthor> | undefined> {
    if (!userId || !this.users) return undefined;
    try {
      const map = await this.users.resolveUserNames([userId]);
      const found = map.get(userId);
      return found?.name ? { name: found.name } : undefined;
    } catch {
      return undefined;
    }
  }

  private publishDocChange(
    spaceId: string,
    docId: string,
    lines: string[],
    version: number,
  ): Promise<void> {
    return this.eventBus.publish({
      type: 'manuscript.document.mutated',
      projectId: spaceId,
      docId,
      lines,
      version,
      source: 'git-bridge',
      occurredAt: Date.now(),
    });
  }

  private async recordHistory(
    spaceId: string,
    pageId: string | undefined,
    sha: string,
    msg: string,
    userId?: string,
  ): Promise<string | null> {
    if (!this.snapshots) return null;
    const short = sha.slice(0, 7);
    const title = msg.split('\n')[0]?.trim();
    const summary = title
      ? `Git push (${short}): ${title}`.slice(0, 500)
      : `Pushed via Git (${short})`;

    const created = await this.snapshots
      .createSnapshot(
        spaceId,
        { summary, isAutomatic: false, pageId },
        userId ?? null,
        pageId,
      )
      .catch(() => null);
    return created?.id ?? null;
  }
}
