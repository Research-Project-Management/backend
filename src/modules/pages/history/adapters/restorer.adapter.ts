/**
 * history/adapters/restorer.adapter.ts
 * Driven Cross-Context Adapter restoring full page snapshots and individual files.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as pathPosix from 'node:path/posix';
import { DistributedLockService, PrismaService, isUuid } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  PageDomainEventBus,
  PagesDomainError,
  ensureCanonicalPageId,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import { FilestoreService } from '@/modules/pages/filestore';
import {
  StructureRepository,
  StructureService,
  type PageNodeEntity,
} from '@/modules/pages/structure';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import {
  HistoryRepository,
  resolveCasFileBlobId,
} from '../history.repository';
import { SnapshotCollectorAdapter } from './collector.adapter';
import { Snapshot, FileSnapshotVo } from '../domain/snapshot';
import { SnapshotFileNotFoundException } from '../domain/errors';

export interface RestoreResult {
  restoredFilesCount: number;
  restoredDocIds: string[];
}

export interface RestoreSingleFileResult {
  path: string;
  docId?: string | null;
  fileId?: string | null;
  content?: string;
  rev?: number;
}

@Injectable()
export class SnapshotRestorerAdapter {
  private readonly logger = new Logger(SnapshotRestorerAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    @Optional()
    private readonly distributedLock?: DistributedLockService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly domainEventBus?: PageDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly historyRepository?: HistoryRepository,
    @Optional()
    private readonly filestoreService?: FilestoreService,
    @Optional()
    private readonly collector?: SnapshotCollectorAdapter,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
    @Optional()
    private readonly structureRepository?: StructureRepository,
    @Optional()
    private readonly realtimeService?: RealtimeFacade,
  ) {
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  private getDeps(): RestorerDeps {
    return {
      structureService: this.structureService,
      structureRepository: this.structureRepository,
      docstoreService: this.docstoreService,
      liveCollab: this.liveCollab,
      logger: this.logger,
      prisma: this.prisma,
      domainEventBus: this.domainEventBus,
      historyRepository: this.historyRepository,
      filestoreService: this.filestoreService,
      collector: this.collector,
      filesPort: this.filesPort,
      realtimeService: this.realtimeService,
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
      const lockResource = `pages:restore:${projectId}:${resolvedPageId ?? 'default'}`;
      const lockedResult = await this.distributedLock.withLock(
        lockResource,
        60_000,
        restoreAction,
      );
      if (lockedResult === null) {
        throw new PagesDomainError(
          `Another snapshot restore is already in progress for page "${resolvedPageId ?? projectId}"`,
          {
            code: 'RESTORE_LOCK_CONTENDED',
            statusCode: 409,
            details: { projectId, pageId: resolvedPageId ?? null },
          },
        );
      }
      return lockedResult;
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
            await deleteTreeNodeSilent(deps, projectId, node, targetPageId);
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
        await deleteTreeNodeSilent(deps, projectId, folder, targetPageId);
      } catch (err) {
        this.logger.warn(
          `Could not delete post-snapshot folder ${folder.path} (${folder.id}): ${err}`,
        );
      }
    }

    const folderIdByPath = new Map<string, string>();
    const ensuredParentDirs = new Set<string>(['/']);
    for (const node of currentNodes) {
      if (node.isFolder() && requiredFolders.has(node.path)) {
        ensuredParentDirs.add(node.path);
        folderIdByPath.set(node.path, node.id);
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
          await ensureParentDirSilent(
            deps,
            projectId,
            parentDir,
            targetPageId,
            folderIdByPath,
            ensuredParentDirs,
          );
        } catch (err) {
          this.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
        }
      }

      const parentId =
        parentDir && parentDir !== '.' && parentDir !== '/'
          ? (folderIdByPath.get(parentDir) ?? null)
          : null;
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
            await setRootDocSilent(deps, projectId, existingNode.id);
          }
        } else {
          if (existingNode) {
            if (existingNode.docId) {
              evictedDocIds.push(existingNode.docId);
            }
            await deleteTreeNodeSilent(
              deps,
              projectId,
              existingNode,
              targetPageId,
            );
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

          const newNode = await createTreeNodeSilent(
            deps,
            projectId,
            {
              name: fileName,
              path: filePath,
              type: 'DOC',
              parentId,
              docId: docId ?? undefined,
              isRootDoc: fileVo.isRootDoc,
            },
            targetPageId,
          );

          if (fileVo.isRootDoc) {
            await setRootDocSilent(deps, projectId, newNode.id);
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
      } else if (
        fileVo.type === 'file' &&
        (fileVo.fileId || fileVo.storageKey)
      ) {
        const restoredFileId = await restorePinnedBinaryFile(
          deps,
          projectId,
          filePath,
          fileVo,
          targetPageId,
        );
        if (restoredFileId) {
          if (
            existingNode?.docId &&
            (existingNode.type !== 'FILE' ||
              existingNode.fileId !== restoredFileId)
          ) {
            evictedDocIds.push(existingNode.docId);
          }
          await syncRestoredFileNode(deps, {
            projectId,
            fileName,
            filePath,
            parentId,
            restoredFileId,
            fileVo,
            existingNode: existingNode ?? null,
            targetPageId,
            silent: true,
          });
        }
      }
    }

    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.history.restored',
        projectId,
        pageId: targetPageId,
        version: snapshot.version,
        restoredDocIds,
        evictedDocIds,
        occurredAt: Date.now(),
      });
    }

    // Emit ONE consolidated file-tree update event at the end of full snapshot restore
    this.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'restore',
      node: {
        pageId: targetPageId ?? null,
        version: snapshot.version,
      },
    });

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
  structureRepository?: StructureRepository;
  docstoreService: DocstoreService;
  liveCollab: LiveCollaborationPort;
  logger: Logger;
  prisma?: PrismaService;
  domainEventBus?: PageDomainEventBus;
  historyRepository?: HistoryRepository;
  filestoreService?: FilestoreService;
  collector?: SnapshotCollectorAdapter;
  filesPort?: IFilesPort;
  realtimeService?: RealtimeFacade;
}

const RESTORE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.eps': 'application/postscript',
};

function inferMimeFromPath(filePath: string): string {
  const ext = pathPosix.extname(filePath).toLowerCase();
  return RESTORE_MIME_MAP[ext] || 'application/octet-stream';
}

async function deleteTreeNodeSilent(
  deps: RestorerDeps,
  projectId: string,
  node: PageNodeEntity,
  targetPageId?: string,
): Promise<void> {
  if (deps.structureRepository) {
    await deps.structureRepository.deleteSubtree(
      projectId,
      node.path,
      targetPageId ?? node.pageId ?? null,
    );
    return;
  }
  await deps.structureService.deleteNode(projectId, node.id);
}

async function ensureParentDirSilent(
  deps: RestorerDeps,
  projectId: string,
  parentDir: string,
  targetPageId: string | undefined,
  folderIdByPath: Map<string, string>,
  ensuredParentDirs: Set<string>,
): Promise<void> {
  if (!deps.structureRepository) {
    await deps.structureService.mkdirp(projectId, parentDir, targetPageId);
    let cur = parentDir;
    while (cur && cur !== '.' && cur !== '/') {
      ensuredParentDirs.add(cur);
      cur = pathPosix.dirname(cur);
    }
    return;
  }

  const segments = parentDir.split('/').filter(Boolean);
  let curPath = '';
  let parentId: string | null = null;

  for (const segment of segments) {
    curPath = `${curPath}/${segment}`;
    const knownId = folderIdByPath.get(curPath);
    if (knownId) {
      parentId = knownId;
      ensuredParentDirs.add(curPath);
      continue;
    }

    let found = await deps.structureRepository.findByPath(
      projectId,
      curPath,
      targetPageId,
    );
    if (!found) {
      found = await deps.structureRepository.createNode({
        projectId,
        ...(targetPageId ? { pageId: targetPageId } : {}),
        parentId,
        type: 'FOLDER',
        name: segment,
        path: curPath,
      });
    }
    parentId = found.id;
    folderIdByPath.set(curPath, found.id);
    ensuredParentDirs.add(curPath);
  }
}

async function createTreeNodeSilent(
  deps: RestorerDeps,
  projectId: string,
  input: {
    name: string;
    path: string;
    type: 'DOC' | 'FILE';
    parentId?: string | null;
    docId?: string;
    fileId?: string;
    isRootDoc?: boolean;
  },
  targetPageId?: string,
): Promise<PageNodeEntity> {
  if (deps.structureRepository) {
    return deps.structureRepository.createNode({
      projectId,
      ...(targetPageId ? { pageId: targetPageId } : {}),
      parentId: input.parentId ?? null,
      type: input.type,
      name: input.name,
      path: input.path,
      docId: input.docId,
      fileId: input.fileId,
      isRootDoc: input.isRootDoc,
    });
  }
  return deps.structureService.createNode(
    projectId,
    {
      name: input.name,
      path: input.path,
      type: input.type,
      docId: input.docId,
      fileId: input.fileId,
      isRootDoc: input.isRootDoc,
    },
    targetPageId,
  );
}

async function setRootDocSilent(
  deps: RestorerDeps,
  projectId: string,
  nodeId: string,
): Promise<void> {
  if (deps.structureRepository) {
    await deps.structureRepository.setRootDoc(projectId, nodeId);
    return;
  }
  await deps.structureService.setRootDoc(projectId, nodeId);
}

async function syncRestoredFileNode(
  deps: RestorerDeps,
  params: {
    projectId: string;
    fileName: string;
    filePath: string;
    parentId?: string | null;
    restoredFileId: string;
    fileVo: FileSnapshotVo;
    existingNode: PageNodeEntity | null;
    targetPageId?: string;
    silent: boolean;
  },
): Promise<void> {
  const {
    projectId,
    fileName,
    filePath,
    parentId,
    restoredFileId,
    fileVo,
    existingNode,
    targetPageId,
    silent,
  } = params;

  if (existingNode) {
    if (
      existingNode.type !== 'FILE' ||
      existingNode.fileId !== restoredFileId
    ) {
      if (silent) {
        await deleteTreeNodeSilent(deps, projectId, existingNode, targetPageId);
        await createTreeNodeSilent(
          deps,
          projectId,
          {
            name: fileName,
            path: filePath,
            type: 'FILE',
            parentId,
            fileId: restoredFileId,
          },
          targetPageId,
        );
      } else {
        await deps.structureService.deleteNode(projectId, existingNode.id);
        await deps.structureService.createNode(
          projectId,
          {
            name: fileName,
            path: filePath,
            type: 'FILE',
            fileId: restoredFileId,
          },
          targetPageId,
        );
      }
      return;
    }

    if (silent && deps.structureRepository) {
      await deps.structureRepository
        .updateNodeFileId(
          projectId,
          existingNode.id,
          restoredFileId,
          fileVo.sizeBytes,
          fileVo.hash || null,
        )
        .catch(() => undefined);
    } else if (typeof deps.structureService.updateNodeFileId === 'function') {
      await deps.structureService
        .updateNodeFileId(
          projectId,
          existingNode.id,
          restoredFileId,
          fileVo.sizeBytes,
          fileVo.hash || null,
        )
        .catch(() => undefined);
    }
    return;
  }

  if (silent) {
    await createTreeNodeSilent(
      deps,
      projectId,
      {
        name: fileName,
        path: filePath,
        type: 'FILE',
        parentId,
        fileId: restoredFileId,
      },
      targetPageId,
    );
  } else {
    await deps.structureService.createNode(
      projectId,
      {
        name: fileName,
        path: filePath,
        type: 'FILE',
        fileId: restoredFileId,
      },
      targetPageId,
    );
  }
}

async function restorePinnedBinaryFile(
  deps: RestorerDeps,
  projectId: string,
  filePath: string,
  fileVo: FileSnapshotVo,
  targetPageId?: string,
): Promise<string | null> {
  let pinnedStorageKey = fileVo.storageKey?.trim() || null;
  let pinnedHash = (fileVo.hash || '').trim();
  let pinnedSizeBytes = fileVo.sizeBytes;

  if (
    !pinnedStorageKey &&
    pinnedHash &&
    deps.historyRepository?.findBlobInSpace
  ) {
    const blobRecord = await deps.historyRepository
      .findBlobInSpace(projectId, pinnedHash)
      .catch(() => null);
    if (blobRecord?.storageKey) {
      pinnedStorageKey = blobRecord.storageKey.trim();
      pinnedSizeBytes = pinnedSizeBytes || blobRecord.sizeBytes;
    }
  }

  if (!pinnedStorageKey) {
    await undeleteFileRecord(deps, projectId, fileVo.fileId);
    return fileVo.fileId ?? null;
  }

  if (!deps.prisma?.pageFile) {
    await undeleteFileRecord(deps, projectId, fileVo.fileId);
    return fileVo.fileId ?? null;
  }

  const targetBlobId = await resolveCasFileBlobId(deps.prisma, deps.filesPort, {
    blobId: fileVo.blobId,
    storageKey: pinnedStorageKey,
    contentHash: fileVo.hash,
  });
  const relPath = filePath.replace(/^\/+/, '');

  const existingFile =
    fileVo.fileId && isUuid(fileVo.fileId) && deps.prisma.pageFile.findFirst
      ? await Promise.resolve(
          deps.prisma.pageFile.findFirst({
            where: { id: fileVo.fileId, spaceId: projectId },
            select: {
              id: true,
              blobId: true,
              storageKey: true,
              hash: true,
              sizeBytes: true,
              rev: true,
              deletedAt: true,
            },
          }),
        ).catch(() => null)
      : null;

  if (existingFile) {
    const wasDeleted = existingFile.deletedAt !== null;
    const blobChanged =
      existingFile.storageKey !== pinnedStorageKey ||
      existingFile.blobId !== targetBlobId ||
      (pinnedHash && existingFile.hash.trim() !== pinnedHash);

    const netBytesDelta = wasDeleted
      ? BigInt(pinnedSizeBytes)
      : BigInt(pinnedSizeBytes) - BigInt(existingFile.sizeBytes ?? 0);

    if (
      netBytesDelta > 0n &&
      typeof deps.filesPort?.reserveQuota === 'function'
    ) {
      await deps.filesPort
        .reserveQuota(projectId, netBytesDelta)
        .catch(() => undefined);
    } else if (
      netBytesDelta < 0n &&
      typeof deps.filesPort?.releaseQuota === 'function'
    ) {
      await deps.filesPort
        .releaseQuota(projectId, -netBytesDelta)
        .catch(() => undefined);
    }

    if (wasDeleted) {
      if (targetBlobId && typeof deps.filesPort?.acquireBlob === 'function') {
        await deps.filesPort.acquireBlob(targetBlobId).catch(() => null);
      }
    } else if (blobChanged) {
      if (
        targetBlobId &&
        targetBlobId !== existingFile.blobId &&
        typeof deps.filesPort?.acquireBlob === 'function'
      ) {
        await deps.filesPort.acquireBlob(targetBlobId).catch(() => null);
      }
      if (
        existingFile.blobId &&
        existingFile.blobId !== targetBlobId &&
        typeof deps.filesPort?.releaseBlob === 'function'
      ) {
        await deps.filesPort
          .releaseBlob(existingFile.blobId)
          .catch(() => undefined);
      }
    }

    await deps.prisma.pageFile.updateMany({
      where: { id: existingFile.id, spaceId: projectId },
      data: {
        storageKey: pinnedStorageKey,
        hash: pinnedHash || existingFile.hash,
        sizeBytes: pinnedSizeBytes,
        blobId: targetBlobId,
        lastKnownPath: relPath,
        deletedAt: null,
        rev: (existingFile.rev ?? 0) + 1,
      },
    });

    return existingFile.id;
  }

  if (deps.prisma.pageFile.create) {
    const canonicalPageId = await ensureCanonicalPageId(
      deps.prisma,
      projectId,
      targetPageId,
    );
    const newFileId =
      fileVo.fileId && isUuid(fileVo.fileId)
        ? fileVo.fileId
        : crypto.randomUUID();

    if (
      pinnedSizeBytes > 0 &&
      typeof deps.filesPort?.reserveQuota === 'function'
    ) {
      await deps.filesPort
        .reserveQuota(projectId, BigInt(pinnedSizeBytes))
        .catch(() => undefined);
    }
    if (targetBlobId && typeof deps.filesPort?.acquireBlob === 'function') {
      await deps.filesPort.acquireBlob(targetBlobId).catch(() => null);
    }

    await deps.prisma.pageFile.create({
      data: {
        id: newFileId,
        spaceId: projectId,
        pageId: canonicalPageId,
        blobId: targetBlobId,
        lastKnownPath: relPath,
        mimeType: inferMimeFromPath(filePath),
        sizeBytes: pinnedSizeBytes,
        hash: pinnedHash,
        storageKey: pinnedStorageKey,
        bucketName: 'manuscript-files',
        deletedAt: null,
      },
    });
    return newFileId;
  }

  return fileVo.fileId ?? null;
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
  targetPageId?: string,
): Promise<void> {
  const resolvedHistoryRepo =
    deps.historyRepository ??
    (deps.prisma
      ? new HistoryRepository(deps.prisma, deps.filesPort)
      : undefined);
  if (!resolvedHistoryRepo) return;

  try {
    const collector =
      deps.collector ??
      new SnapshotCollectorAdapter(
        deps.structureService,
        deps.docstoreService,
        (deps.filestoreService ?? ({} as FilestoreService)),
        deps.liveCollab,
        undefined,
        deps.filesPort,
      );

    const backupFilesMap = await collector.collectCurrentState(
      projectId,
      targetPageId,
    );
    if (backupFilesMap.size === 0) return;

    const latestVersion = await resolvedHistoryRepo.getLatestVersion(
      projectId,
      targetPageId,
    );
    const safetySnapshot = Snapshot.create({
      projectId,
      spaceId: projectId,
      pageId: targetPageId,
      version: latestVersion + 1,
      summary: `Pre-restore automatic safety snapshot before restoring to v${snapshot.version}`,
      isAutomatic: true,
      files: backupFilesMap,
    });
    await resolvedHistoryRepo.saveSnapshot(safetySnapshot);
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
  } else if (fileVo.type === 'file' && (fileVo.fileId || fileVo.storageKey)) {
    const restoredFileId = await restorePinnedBinaryFile(
      deps,
      projectId,
      targetPath,
      fileVo,
      targetPageId,
    );
    if (restoredFileId) {
      await syncRestoredFileNode(deps, {
        projectId,
        fileName,
        filePath: targetPath,
        restoredFileId,
        fileVo,
        existingNode,
        targetPageId,
        silent: false,
      });
    }
    return {
      path: targetPath,
      fileId: restoredFileId,
    };
  }

  return { path: targetPath };
}
