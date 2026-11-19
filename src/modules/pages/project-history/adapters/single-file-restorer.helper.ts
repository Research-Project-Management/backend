/**
 * project-history/adapters/single-file-restorer.helper.ts
 * Shared restoration helpers (safety backup, record undeletion, doc sync, single-file restore).
 */

import { Logger } from '@nestjs/common';
import * as pathPosix from 'node:path/posix';
import { Prisma } from '@prisma/client';
import { PrismaService, mapWithConcurrency } from '@/core';
import { ensureCanonicalPageId } from '@/modules/pages/core/page-scope.helper';
import {
  LiveCollaborationPort,
  PageDomainEventBus,
} from '@/modules/pages/core';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';
import { ProjectHistoryRepository } from '../project-history.repository';
import { FileSnapshotVo, RestoreSingleFileResult, Snapshot } from '../domain';

export interface RestorerDeps {
  structureService: StructureService;
  docstoreService: DocstoreService;
  liveCollab: LiveCollaborationPort;
  logger: Logger;
  prisma?: PrismaService;
  domainEventBus?: PageDomainEventBus;
  historyRepository?: ProjectHistoryRepository;
  filestoreService?: FilestoreService;
}

export async function undeleteDocRecord(
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

export async function undeleteFileRecord(
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

export async function restoreOrCreateDoc(
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

export async function publishOrSyncRestoredDoc(
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

export async function createPreRestoreSafetySnapshot(
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
      await deps.prisma.pageSnapshot.create({
        data: {
          spaceId: projectId,
          pageId: snapshotPageId,
          version: backupVersion,
          summary: backupSummary,
          isAutomatic: true,
          files:
            Object.keys(filesJson).length > 0
              ? (filesJson as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          sizeBytes,
        },
      });
    }
  } catch (backupErr) {
    deps.logger.warn(
      'Could not create pre-restore safety snapshot: ' + String(backupErr),
    );
  }
}

export async function restoreSingleFileToStateHelper(
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
    throw new Error(
      `File '${pathname}' was not found in version ${snapshot.version} snapshot.`,
    );
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
