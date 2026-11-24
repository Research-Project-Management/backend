/**
 * project-history/adapters/snapshot-restorer.adapter.ts
 * Driven Cross-Context Adapter restoring full page snapshots and individual files.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import * as pathPosix from 'node:path/posix';
import { Prisma } from '@prisma/client';
import { PrismaService, mapWithConcurrency } from '@/core';
import { ensureCanonicalPageId } from '@/modules/pages/core/page-scope.helper';
import {
  LiveCollaborationPort,
  LIVE_COLLABORATION_PORT,
  NOOP_LIVE_COLLABORATION,
  PageDomainEventBus,
  IDistributedLockPort,
} from '@/modules/pages/core';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';
import { HistoryRepository } from '../history.repository';
import {
  ISnapshotRestorerPort,
  RestoreResult,
  RestoreSingleFileResult,
} from '../domain/ports';
import { Snapshot } from '../domain/snapshot.entity';
import { FileSnapshotVo } from '../domain/file-snapshot.vo';
import { SnapshotFileNotFoundException } from '../domain/errors';

@Injectable()
export class SnapshotRestorerAdapter extends ISnapshotRestorerPort {
  private readonly logger = new Logger(SnapshotRestorerAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(IDistributedLockPort)
    private readonly distributedLock?: IDistributedLockPort,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly domainEventBus?: PageDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly historyRepository?: HistoryRepository,
    @Optional()
    private readonly filestoreService?: FilestoreService,
  ) {
    super();
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  private getDeps(): RestorerDeps {
    return {
      structureService: this.structureService,
      docstoreService: this.docstoreService,
      liveCollab: this.liveCollab,
      logger: this.logger,
      prisma: this.prisma,
      domainEventBus: this.domainEventBus,
      historyRepository: this.historyRepository,
      filestoreService: this.filestoreService,
    };
  }

  public async restoreToState(
    projectId: string,
    snapshot: Snapshot,
    pageId?: string,
  ): Promise<RestoreResult> {
    const resolvedPageId =
      pageId ??
      snapshot.pageId ??
      (this.prisma
        ? await ensureCanonicalPageId(this.prisma, projectId).catch(
            () => undefined,
          )
        : undefined);
    const restoreAction = async () =>
      this.executeRestoreWorkflow(projectId, snapshot, resolvedPageId);

    if (this.distributedLock) {
      return this.distributedLock.withLock(
        `manuscript:restore:${projectId}:${resolvedPageId ?? 'default'}`,
        restoreAction,
        60000,
      );
    }
    return restoreAction();
  }

  private async executeRestoreWorkflow(
    projectId: string,
    snapshot: Snapshot,
    pageId?: string,
  ): Promise<RestoreResult> {
    const deps = this.getDeps();
    const targetPageId = pageId ?? snapshot.pageId;
    const currentNodes = await this.structureService.getAllNodes(
      projectId,
      undefined,
      targetPageId,
    );
    const activeDocIds = currentNodes
      .filter((n) => n.docId)
      .map((n) => n.docId as string);

    await this.liveCollab.flushDocs(projectId, activeDocIds).catch((err) => {
      this.logger.warn(
        `Failed to flush project ${projectId} prior to restore: ${err}`,
      );
      return [];
    });

    // Pre-Restore Safety Guard: Snapshot current state if repository or prisma available to prevent partial restore data loss
    await createPreRestoreSafetySnapshot(
      deps,
      projectId,
      snapshot,
      currentNodes,
      targetPageId,
    );

    const currentByPath = new Map<string, PageNodeEntity>(
      currentNodes.map((n: PageNodeEntity) => [n.path, n]),
    );
    const snapshotFiles = snapshot.files;
    const restoredDocIds: string[] = [];
    const evictedDocIds: string[] = [];

    const requiredFolders = new Set<string>();
    for (const filePath of snapshotFiles.keys()) {
      let dir = pathPosix.dirname(filePath);
      while (dir && dir !== '.' && dir !== '/') {
        requiredFolders.add(dir);
        dir = pathPosix.dirname(dir);
      }
    }

    const postSnapshotFileNodes = currentNodes.filter(
      (node) => !node.isFolder() && !snapshotFiles.has(node.path),
    );
    for (const removedNode of postSnapshotFileNodes) {
      if (removedNode.docId) {
        evictedDocIds.push(removedNode.docId);
      }
    }
    if (postSnapshotFileNodes.length > 0) {
      await Promise.all(
        postSnapshotFileNodes.map(async (node) => {
          try {
            await this.structureService.deleteNode(projectId, node.id);
          } catch (err) {
            this.logger.warn(
              `Could not delete post-snapshot node ${node.path} (${node.id}): ${err}`,
            );
          }
        }),
      );
    }

    const orphanFolders = currentNodes
      .filter(
        (node) =>
          node.isFolder() &&
          node.path !== '/' &&
          !requiredFolders.has(node.path),
      )
      .sort((a, b) => b.path.length - a.path.length);

    for (const folder of orphanFolders) {
      try {
        await this.structureService.deleteNode(projectId, folder.id);
      } catch (err) {
        this.logger.warn(
          `Could not delete post-snapshot folder ${folder.path} (${folder.id}): ${err}`,
        );
      }
    }

    const ensuredParentDirs = new Set<string>(['/']);
    for (const node of currentNodes) {
      if (node.isFolder() && requiredFolders.has(node.path)) {
        ensuredParentDirs.add(node.path);
      }
    }

    for (const [filePath, fileVo] of snapshotFiles.entries()) {
      const fileName = pathPosix.basename(filePath);
      const parentDir = pathPosix.dirname(filePath);

      if (
        parentDir &&
        parentDir !== '.' &&
        parentDir !== '/' &&
        !ensuredParentDirs.has(parentDir)
      ) {
        try {
          await this.structureService.mkdirp(
            projectId,
            parentDir,
            targetPageId,
          );
          let cur = parentDir;
          while (cur && cur !== '.' && cur !== '/') {
            ensuredParentDirs.add(cur);
            cur = pathPosix.dirname(cur);
          }
        } catch (err) {
          this.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
        }
      }

      const existingNode = currentByPath.get(filePath);

      if (fileVo.type === 'doc') {
        const lines = fileVo.lines || [''];
        let docIdToSync: string | null = null;
        let syncedRev: number | undefined;
        let syncedVersion: number | undefined;

        await undeleteDocRecord(this.prisma, projectId, fileVo.docId);

        if (existingNode && existingNode.isDoc() && existingNode.docId) {
          await undeleteDocRecord(this.prisma, projectId, existingNode.docId);
          const updated = await this.docstoreService.updateDoc(
            projectId,
            existingNode.docId,
            { lines },
          );
          syncedRev = updated?.rev ?? updated?.doc?.rev;
          syncedVersion = updated?.doc?.version;
          docIdToSync = existingNode.docId;
          restoredDocIds.push(existingNode.docId);

          if (fileVo.isRootDoc) {
            await this.structureService.setRootDoc(projectId, existingNode.id);
          }
        } else {
          if (existingNode) {
            if (existingNode.docId) {
              evictedDocIds.push(existingNode.docId);
            }
            await this.structureService.deleteNode(projectId, existingNode.id);
          }

          const { docId, rev, version } = await restoreOrCreateDoc(
            this.docstoreService,
            projectId,
            filePath,
            lines,
            fileVo.docId,
            targetPageId,
          );
          syncedRev = rev;
          syncedVersion = version;
          if (docId) {
            docIdToSync = docId;
            restoredDocIds.push(docId);
          }

          const newNode = await this.structureService.createNode(
            projectId,
            {
              name: fileName,
              path: filePath,
              type: 'DOC',
              docId: docId ?? undefined,
              isRootDoc: fileVo.isRootDoc,
            },
            targetPageId,
          );

          if (fileVo.isRootDoc) {
            await this.structureService.setRootDoc(projectId, newNode.id);
          }
        }

        if (docIdToSync) {
          await publishOrSyncRestoredDoc(
            deps,
            projectId,
            docIdToSync,
            lines,
            syncedRev,
            syncedVersion,
          );
        }
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        await undeleteFileRecord(deps, projectId, fileVo.fileId);
        if (existingNode) {
          if (
            existingNode.type !== 'FILE' ||
            existingNode.fileId !== fileVo.fileId
          ) {
            if (existingNode.docId) {
              evictedDocIds.push(existingNode.docId);
            }
            await this.structureService.deleteNode(projectId, existingNode.id);
            await this.structureService.createNode(
              projectId,
              {
                name: fileName,
                path: filePath,
                type: 'FILE',
                fileId: fileVo.fileId,
              },
              targetPageId,
            );
          }
        } else {
          await this.structureService.createNode(
            projectId,
            {
              name: fileName,
              path: filePath,
              type: 'FILE',
              fileId: fileVo.fileId,
            },
            targetPageId,
          );
        }
      }
    }

    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.history.restored',
        projectId,
        pageId: targetPageId,
        version:
          typeof snapshot.version === 'number'
            ? snapshot.version
            : ((snapshot.version as { value?: number } | undefined)?.value ??
              0),
        restoredDocIds,
        evictedDocIds,
        occurredAt: Date.now(),
      });
    }

    return {
      restoredFilesCount: snapshotFiles.size,
      restoredDocIds,
    };
  }

  public async restoreSingleFileToState(
    projectId: string,
    snapshot: Snapshot,
    pathname: string,
    hintFileId?: string,
    pageId?: string,
  ): Promise<RestoreSingleFileResult> {
    return restoreSingleFileToStateHelper(
      this.getDeps(),
      projectId,
      snapshot,
      pathname,
      hintFileId,
      pageId,
    );
  }
}

interface RestorerDeps {
  structureService: StructureService;
  docstoreService: DocstoreService;
  liveCollab: LiveCollaborationPort;
  logger: Logger;
  prisma?: PrismaService;
  domainEventBus?: PageDomainEventBus;
  historyRepository?: HistoryRepository;
  filestoreService?: FilestoreService;
}

async function undeleteDocRecord(
  prisma: PrismaService | undefined,
  projectId: string,
  docId?: string | null,
): Promise<void> {
  if (!docId || !prisma?.pageDoc?.updateMany) return;
  await prisma.pageDoc
    .updateMany({
      where: { id: docId, spaceId: projectId },
      data: { deletedAt: null },
    })
    .catch(() => {});
}

async function undeleteFileRecord(
  deps: Pick<RestorerDeps, 'prisma' | 'filestoreService'>,
  projectId: string,
  fileId?: string | null,
): Promise<void> {
  if (!fileId) return;
  if (deps.filestoreService?.restoreFile) {
    const restored = await deps.filestoreService
      .restoreFile(projectId, fileId)
      .catch(() => false);
    if (restored) return;
  }
  if (!deps.prisma?.pageFile?.updateMany) return;
  await deps.prisma.pageFile
    .updateMany({
      where: { id: fileId, spaceId: projectId },
      data: { deletedAt: null },
    })
    .catch(() => {});
}

async function restoreOrCreateDoc(
  docstoreService: DocstoreService,
  projectId: string,
  filePath: string,
  lines: string[],
  candidateDocId?: string | null,
  pageId?: string,
): Promise<{
  docId: string | null;
  rev?: number;
  version?: number;
}> {
  let targetDocId = candidateDocId ?? null;
  let syncedRev: number | undefined;
  let syncedVersion: number | undefined;

  if (targetDocId) {
    const updated = await docstoreService
      .updateDoc(projectId, targetDocId, { lines })
      .catch(() => {
        targetDocId = null;
        return null;
      });
    if (updated) {
      syncedRev = updated.rev ?? updated.doc?.rev;
      syncedVersion = updated.doc?.version;
    }
  }

  if (!targetDocId) {
    const createdDoc = await docstoreService.createDoc(projectId, {
      path: filePath,
      lines,
      ...(pageId ? { pageId } : {}),
    });
    const createdRef = createdDoc as {
      id?: string;
      _id?: string;
      rev?: number;
      version?: number;
    };
    targetDocId = createdRef.id || createdRef._id || null;
    syncedRev = createdRef.rev;
    syncedVersion = createdRef.version;
  }

  return { docId: targetDocId, rev: syncedRev, version: syncedVersion };
}

async function publishOrSyncRestoredDoc(
  deps: Pick<RestorerDeps, 'domainEventBus' | 'liveCollab'>,
  projectId: string,
  docId: string,
  lines: string[],
  rev?: number,
  version?: number,
): Promise<void> {
  if (deps.domainEventBus) {
    await deps.domainEventBus.publish({
      type: 'manuscript.document.mutated',
      projectId,
      docId,
      lines,
      rev,
      version,
      source: 'history-restore',
      occurredAt: Date.now(),
    });
  } else {
    await deps.liveCollab
      .applyExternalText(projectId, docId, lines.join('\n'))
      .catch(() => false);
  }
}

async function createPreRestoreSafetySnapshot(
  deps: RestorerDeps,
  projectId: string,
  snapshot: Snapshot,
  currentNodes: PageNodeEntity[],
  targetPageId?: string,
): Promise<void> {
  const resolvedHistoryRepo = deps.historyRepository;
  if (!resolvedHistoryRepo && !deps.prisma) return;

  try {
    const backupFilesMap = new Map<string, FileSnapshotVo>();
    const backupEntries = await mapWithConcurrency(
      currentNodes,
      8,
      async (node) => {
        if (node.isFolder()) return null;
        if (node.isDoc() && node.docId) {
          try {
            const doc = await deps.docstoreService.getDoc(
              projectId,
              node.docId,
            );
            return {
              path: node.path,
              vo: FileSnapshotVo.createDoc(
                node.path,
                node.docId,
                doc.lines || [''],
                doc.hash || '',
                node.isRootDoc,
              ),
            };
          } catch {
            // ignore doc fetch errors during safety backup
            return null;
          }
        } else if (node.type === 'FILE' && node.fileId) {
          return {
            path: node.path,
            vo: FileSnapshotVo.createFile(
              node.path,
              node.fileId,
              node.hash || '',
              node.sizeBytes || 0,
            ),
          };
        }
        return null;
      },
    );
    for (const item of backupEntries) {
      if (item) {
        backupFilesMap.set(item.path, item.vo);
      }
    }

    const backupSummary =
      'Pre-restore automatic safety snapshot before restoring to v' +
      snapshot.version;

    if (resolvedHistoryRepo) {
      const latestVersion = await resolvedHistoryRepo.getLatestVersion(
        projectId,
        targetPageId,
      );
      const safetySnapshot = Snapshot.create({
        projectId,
        spaceId: projectId,
        pageId: targetPageId,
        version: latestVersion + 1,
        summary: backupSummary,
        isAutomatic: true,
        files: backupFilesMap,
      });
      await resolvedHistoryRepo.saveSnapshot(safetySnapshot);
    } else if (deps.prisma) {
      const snapshotPageId = await ensureCanonicalPageId(
        deps.prisma,
        projectId,
        targetPageId,
      );
      const latestSnap = await deps.prisma.pageSnapshot.findFirst({
        where: { spaceId: projectId, pageId: snapshotPageId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const backupVersion = (latestSnap?.version ?? 0) + 1;
      const safetySnapshot = Snapshot.create({
        projectId,
        spaceId: projectId,
        pageId: snapshotPageId,
        version: backupVersion,
        summary: backupSummary,
        isAutomatic: true,
        files: backupFilesMap,
      });
      const filesJson = safetySnapshot.toFilesJson();
      const sizeBytes = Buffer.byteLength(JSON.stringify(filesJson), 'utf8');
      await (deps.prisma.pageSnapshot as any).create({
        data: {
          spaceId: projectId,
          pageId: snapshotPageId,
          version: backupVersion,
          summary: backupSummary,
          isAutomatic: true,
          totalBytes: sizeBytes,
        },
      });
    }
  } catch (backupErr) {
    deps.logger.warn(
      'Could not create pre-restore safety snapshot: ' + String(backupErr),
    );
  }
}

async function restoreSingleFileToStateHelper(
  deps: RestorerDeps,
  projectId: string,
  snapshot: Snapshot,
  pathname: string,
  hintFileId?: string,
  pageId?: string,
): Promise<RestoreSingleFileResult> {
  const targetPageId = pageId ?? snapshot.pageId;
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const fileVo =
    snapshot.getFile(normalizedPath) ??
    Array.from(snapshot.files.values()).find(
      (f) =>
        f.path === normalizedPath ||
        f.path.replace(/^\/+/, '') === normalizedPath.replace(/^\/+/, '') ||
        (hintFileId && (f.docId === hintFileId || f.fileId === hintFileId)),
    ) ??
    null;

  if (!fileVo) {
    throw new SnapshotFileNotFoundException(pathname, snapshot.version);
  }

  const targetPath = fileVo.path;
  const fileName = pathPosix.basename(targetPath);
  const parentDir = pathPosix.dirname(targetPath);

  if (parentDir && parentDir !== '.' && parentDir !== '/') {
    try {
      await deps.structureService.mkdirp(projectId, parentDir, targetPageId);
    } catch (err) {
      deps.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
    }
  }

  const currentNodes = await deps.structureService.getAllNodes(
    projectId,
    undefined,
    targetPageId,
  );
  const existingNode =
    currentNodes.find(
      (n) =>
        n.path === targetPath ||
        n.path.replace(/^\/+/, '') === targetPath.replace(/^\/+/, ''),
    ) ?? null;

  if (fileVo.type === 'doc') {
    const lines = fileVo.lines || [''];
    const content = lines.join('\n');
    let docIdToSync: string | null = null;
    let syncedRev: number | undefined;
    let syncedVersion: number | undefined;

    if (existingNode?.docId) {
      await deps.liveCollab
        .flushDocs(projectId, [existingNode.docId])
        .catch(() => []);
    }

    await undeleteDocRecord(deps.prisma, projectId, fileVo.docId);

    if (existingNode && existingNode.isDoc() && existingNode.docId) {
      await undeleteDocRecord(deps.prisma, projectId, existingNode.docId);
      const updated = await deps.docstoreService.updateDoc(
        projectId,
        existingNode.docId,
        { lines },
      );
      syncedRev = updated?.rev ?? updated?.doc?.rev;
      syncedVersion = updated?.doc?.version;
      docIdToSync = existingNode.docId;
    } else {
      if (existingNode) {
        await deps.structureService.deleteNode(projectId, existingNode.id);
      }

      const { docId, rev, version } = await restoreOrCreateDoc(
        deps.docstoreService,
        projectId,
        targetPath,
        lines,
        fileVo.docId ?? hintFileId,
        targetPageId,
      );
      docIdToSync = docId;
      syncedRev = rev;
      syncedVersion = version;

      await deps.structureService.createNode(
        projectId,
        {
          name: fileName,
          path: targetPath,
          type: 'DOC',
          docId: docId ?? undefined,
          isRootDoc: fileVo.isRootDoc,
        },
        targetPageId,
      );
    }

    if (docIdToSync) {
      await publishOrSyncRestoredDoc(
        deps,
        projectId,
        docIdToSync,
        lines,
        syncedRev,
        syncedVersion,
      );
    }

    return {
      path: targetPath,
      docId: docIdToSync,
      content,
      rev: syncedRev,
    };
  } else if (fileVo.type === 'file' && fileVo.fileId) {
    await undeleteFileRecord(deps, projectId, fileVo.fileId);
    if (existingNode) {
      if (
        existingNode.type !== 'FILE' ||
        existingNode.fileId !== fileVo.fileId
      ) {
        await deps.structureService.deleteNode(projectId, existingNode.id);
        await deps.structureService.createNode(
          projectId,
          {
            name: fileName,
            path: targetPath,
            type: 'FILE',
            fileId: fileVo.fileId,
          },
          targetPageId,
        );
      }
    } else {
      await deps.structureService.createNode(
        projectId,
        {
          name: fileName,
          path: targetPath,
          type: 'FILE',
          fileId: fileVo.fileId,
        },
        targetPageId,
      );
    }
    return {
      path: targetPath,
      fileId: fileVo.fileId,
    };
  }

  return { path: targetPath };
}
