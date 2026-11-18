/**
 * project-history/adapters/project-history.adapters.ts
 * Driven Cross-Context Adapters for Project History:
 * - ManuscriptCollectorAdapter (Port: IProjectCollectorPort)
 * - ManuscriptRestorerAdapter (Port: IProjectRestorerPort)
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
  ManuscriptDomainEventBus,
  IDistributedLockPort,
} from '@/modules/pages/core';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import type { ManuscriptNodeEntity } from '@/modules/pages/structure/domain';
import { ProjectHistoryRepository } from '../project-history.repository';
import {
  IHistoryRepositoryPort,
  IProjectCollectorPort,
  IProjectRestorerPort,
  RestoreResult,
  RestoreSingleFileResult,
  Snapshot,
  FileSnapshotVo,
} from '../domain';
import { Readable } from 'node:stream';
import { createZipStream, type ZipEntry } from '@/modules/pages/core';

const COLLECT_CONCURRENCY = 6;

@Injectable()
export class ManuscriptCollectorAdapter extends IProjectCollectorPort {
  private readonly logger = new Logger(ManuscriptCollectorAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional()
    liveCollab?: LiveCollaborationPort,
  ) {
    super();
    const candidate = liveCollab ?? liveCollabOrLegacyRef;
    this.liveCollab =
      candidate &&
      typeof (candidate as LiveCollaborationPort).flushDocs === 'function'
        ? (candidate as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
  }

  private getLiveCollab(): LiveCollaborationPort {
    return this.liveCollab;
  }

  public async collectCurrentState(
    projectId: string,
    pageId?: string,
  ): Promise<Map<string, FileSnapshotVo>> {
    const nodes = await this.structureService.getAllNodes(
      projectId,
      undefined,
      pageId,
    );

    const docIds = nodes.filter((n) => n.docId).map((n) => n.docId as string);
    await this.getLiveCollab()
      .flushDocs(projectId, docIds)
      .catch(() => []);

    const filesMap = new Map<string, FileSnapshotVo>();

    const collected = await mapWithConcurrency<
      ManuscriptNodeEntity,
      FileSnapshotVo | null
    >(
      nodes.filter((n) => !n.isFolder()),
      COLLECT_CONCURRENCY,
      async (node: ManuscriptNodeEntity): Promise<FileSnapshotVo | null> => {
        if (node.isDoc() && node.docId) {
          try {
            const doc = await this.docstoreService.getDoc(
              projectId,
              node.docId,
            );
            return FileSnapshotVo.createDoc(
              node.path,
              node.docId,
              doc.lines || [''],
              doc.hash || '',
              node.isRootDoc,
            );
          } catch (error) {
            this.logger.error(
              `Error collecting doc ${node.docId} at path ${node.path}: ${error}`,
            );
          }
        } else if (node.type === 'FILE' && node.fileId) {
          try {
            const fileMeta = await this.filestoreService.getFileMetadata(
              projectId,
              node.fileId,
            );
            const hashString = fileMeta.hash
              ? fileMeta.hash.getValue()
              : node.hash || '';
            return FileSnapshotVo.createFile(
              node.path,
              node.fileId,
              hashString,
              fileMeta.sizeBytes || node.sizeBytes || 0,
            );
          } catch (error) {
            this.logger.error(
              `Error collecting file ${node.fileId} at path ${node.path}: ${error}`,
            );
          }
        }
        return null;
      },
    );
    for (const vo of collected) {
      if (vo) filesMap.set(vo.path, vo);
    }

    return filesMap;
  }

  public createSnapshotZipStream(
    projectId: string,
    snapshot: Snapshot,
  ): { zipStream: Readable; fileCount: number } {
    const entries: ZipEntry[] = [];
    const snapshotFiles = snapshot.files;

    for (const [filePath, fileVo] of snapshotFiles.entries()) {
      const relPath = filePath.replace(/^\/+/, '');
      if (!relPath) continue;

      if (fileVo.type === 'doc') {
        const textContent = (fileVo.lines || ['']).join('\n');
        entries.push({
          path: relPath,
          data: Buffer.from(textContent, 'utf8'),
          date: snapshot.createdAt,
        });
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        const fileId = fileVo.fileId;
        entries.push({
          path: relPath,
          date: snapshot.createdAt,
          getData: async () => {
            try {
              const streamResult = await this.filestoreService.openReadStream(
                projectId,
                fileId,
              );
              const chunks: Buffer[] = [];
              for await (const chunk of streamResult.stream) {
                chunks.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
              }
              return Buffer.concat(chunks);
            } catch (err) {
              this.logger.warn(
                `Failed to read historical file ${fileId} (${relPath}) for snapshot ZIP: ${err}`,
              );
              return null;
            }
          },
        });
      }
    }

    if (entries.length === 0) {
      entries.push({
        path: 'main.tex',
        data: Buffer.from(
          '\\documentclass{article}\n\\begin{document}\n\\end{document}',
          'utf8',
        ),
        date: snapshot.createdAt,
      });
    }

    return {
      zipStream: createZipStream(entries),
      fileCount: entries.length,
    };
  }
}

@Injectable()
export class ManuscriptRestorerAdapter extends IProjectRestorerPort {
  private readonly logger = new Logger(ManuscriptRestorerAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(IDistributedLockPort)
    private readonly lockOrLegacyRef?: IDistributedLockPort | unknown,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly historyRepository?: ProjectHistoryRepository,
    @Optional()
    private readonly distributedLock?: IDistributedLockPort,
    @Optional()
    private readonly filestoreService?: FilestoreService,
  ) {
    super();
    this.liveCollab =
      liveCollab && typeof liveCollab.flushDocs === 'function'
        ? liveCollab
        : NOOP_LIVE_COLLABORATION;
  }

  private getLiveCollab(): LiveCollaborationPort {
    return this.liveCollab;
  }

  private async undeleteDocRecord(
    projectId: string,
    docId?: string | null,
  ): Promise<void> {
    if (!docId || !this.prisma?.pageDoc?.updateMany) return;
    await this.prisma.pageDoc
      .updateMany({
        where: { id: docId, spaceId: projectId },
        data: { deletedAt: null },
      })
      .catch(() => {});
  }

  private async undeleteFileRecord(
    projectId: string,
    fileId?: string | null,
  ): Promise<void> {
    if (!fileId) return;
    if (this.filestoreService?.restoreFile) {
      const restored = await this.filestoreService
        .restoreFile(projectId, fileId)
        .catch(() => false);
      if (restored) return;
    }
    if (!this.prisma?.pageFile?.updateMany) return;
    await this.prisma.pageFile
      .updateMany({
        where: { id: fileId, spaceId: projectId },
        data: { deletedAt: null },
      })
      .catch(() => {});
  }

  private async restoreOrCreateDoc(
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
      const updated = await this.docstoreService
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
      const createdDoc = await this.docstoreService.createDoc(projectId, {
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
    const lockPort =
      this.distributedLock ??
      (this.lockOrLegacyRef &&
      typeof (this.lockOrLegacyRef as IDistributedLockPort).withLock ===
        'function'
        ? (this.lockOrLegacyRef as IDistributedLockPort)
        : undefined);
    const restoreAction = async () =>
      this.executeRestoreWorkflow(projectId, snapshot, resolvedPageId);

    if (lockPort) {
      return lockPort.withLock(
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
    const targetPageId = pageId ?? snapshot.pageId;
    const currentNodes = await this.structureService.getAllNodes(
      projectId,
      undefined,
      targetPageId,
    );
    const activeDocIds = currentNodes
      .filter((n) => n.docId)
      .map((n) => n.docId as string);

    await this.getLiveCollab()
      .flushDocs(projectId, activeDocIds)
      .catch((err) => {
        this.logger.warn(
          `Failed to flush project ${projectId} prior to restore: ${err}`,
        );
        return [];
      });

    // Pre-Restore Safety Guard: Snapshot current state if repository or prisma available to prevent partial restore data loss
    const resolvedHistoryRepo = this.historyRepository;

    if (resolvedHistoryRepo || this.prisma) {
      try {
        const backupFilesMap = new Map<string, FileSnapshotVo>();
        const backupEntries = await mapWithConcurrency(
          currentNodes,
          8,
          async (node) => {
            if (node.isFolder()) return null;
            if (node.isDoc() && node.docId) {
              try {
                const doc = await this.docstoreService.getDoc(
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
        } else if (this.prisma) {
          const snapshotPageId = await ensureCanonicalPageId(
            this.prisma,
            projectId,
            targetPageId,
          );
          const latestSnap = await this.prisma.pageSnapshot.findFirst({
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
          const sizeBytes = Buffer.byteLength(
            JSON.stringify(filesJson),
            'utf8',
          );
          await this.prisma.pageSnapshot.create({
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
        this.logger.warn(
          'Could not create pre-restore safety snapshot: ' + String(backupErr),
        );
      }
    }

    const currentByPath = new Map<string, ManuscriptNodeEntity>(
      currentNodes.map((n: ManuscriptNodeEntity) => [n.path, n]),
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

        await this.undeleteDocRecord(projectId, fileVo.docId);

        if (existingNode && existingNode.isDoc() && existingNode.docId) {
          await this.undeleteDocRecord(projectId, existingNode.docId);
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

          const { docId, rev, version } = await this.restoreOrCreateDoc(
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
          if (this.domainEventBus) {
            await this.domainEventBus.publish({
              type: 'manuscript.document.mutated',
              projectId,
              docId: docIdToSync,
              lines,
              rev: syncedRev,
              version: syncedVersion,
              source: 'history-restore',
              occurredAt: Date.now(),
            });
          } else {
            await this.getLiveCollab()
              .applyExternalText(projectId, docIdToSync, lines.join('\n'))
              .catch(() => false);
          }
        }
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        await this.undeleteFileRecord(projectId, fileVo.fileId);
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
        await this.structureService.mkdirp(projectId, parentDir, targetPageId);
      } catch (err) {
        this.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
      }
    }

    const currentNodes = await this.structureService.getAllNodes(
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
        await this.getLiveCollab()
          .flushDocs(projectId, [existingNode.docId])
          .catch(() => []);
      }

      await this.undeleteDocRecord(projectId, fileVo.docId);

      if (existingNode && existingNode.isDoc() && existingNode.docId) {
        await this.undeleteDocRecord(projectId, existingNode.docId);
        const updated = await this.docstoreService.updateDoc(
          projectId,
          existingNode.docId,
          { lines },
        );
        syncedRev = updated?.rev ?? updated?.doc?.rev;
        syncedVersion = updated?.doc?.version;
        docIdToSync = existingNode.docId;
      } else {
        if (existingNode) {
          await this.structureService.deleteNode(projectId, existingNode.id);
        }

        const { docId, rev, version } = await this.restoreOrCreateDoc(
          projectId,
          targetPath,
          lines,
          fileVo.docId ?? hintFileId,
          targetPageId,
        );
        docIdToSync = docId;
        syncedRev = rev;
        syncedVersion = version;

        await this.structureService.createNode(
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
        if (this.domainEventBus) {
          await this.domainEventBus.publish({
            type: 'manuscript.document.mutated',
            projectId,
            docId: docIdToSync,
            lines,
            rev: syncedRev,
            version: syncedVersion,
            source: 'history-restore',
            occurredAt: Date.now(),
          });
        } else {
          await this.getLiveCollab()
            .applyExternalText(projectId, docIdToSync, content)
            .catch(() => false);
        }
      }

      return {
        path: targetPath,
        docId: docIdToSync,
        content,
        rev: syncedRev,
      };
    } else if (fileVo.type === 'file' && fileVo.fileId) {
      await this.undeleteFileRecord(projectId, fileVo.fileId);
      if (existingNode) {
        if (
          existingNode.type !== 'FILE' ||
          existingNode.fileId !== fileVo.fileId
        ) {
          await this.structureService.deleteNode(projectId, existingNode.id);
          await this.structureService.createNode(
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
        await this.structureService.createNode(
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
}
