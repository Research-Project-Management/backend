/**
 * project-history/adapters/project-history.adapters.ts
 * Driven Cross-Context Adapters for Project History:
 * - ManuscriptCollectorAdapter (Port: IProjectCollectorPort)
 * - ManuscriptRestorerAdapter (Port: IProjectRestorerPort)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as pathPosix from 'node:path/posix';
import { Prisma } from '@prisma/client';
import { PrismaService, mapWithConcurrency } from '@/core';
import {
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
} from '@/modules/manuscripts/core';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import type { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';
import {
  IProjectCollectorPort,
  IProjectRestorerPort,
  RestoreResult,
  Snapshot,
  FileSnapshotVo,
} from '../domain';

const COLLECT_CONCURRENCY = 6;

@Injectable()
export class ManuscriptCollectorAdapter extends IProjectCollectorPort {
  private readonly logger = new Logger(ManuscriptCollectorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    super();
  }

  public async collectCurrentState(
    projectId: string,
  ): Promise<Map<string, FileSnapshotVo>> {
    const nodes = await this.structureService.getAllNodes(projectId);

    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, {
        strict: false,
      });
      if (live) {
        const docIds = nodes
          .filter((n) => n.docId)
          .map((n) => n.docId as string);
        await live.flushDocs(projectId, docIds);
      }
    } catch {
      // non-blocking live flush fallback
    }

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
}

@Injectable()
export class ManuscriptRestorerAdapter extends IProjectRestorerPort {
  private readonly logger = new Logger(ManuscriptRestorerAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
  ) {
    super();
  }

  public async restoreToState(
    projectId: string,
    snapshot: Snapshot,
  ): Promise<RestoreResult> {
    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, {
        strict: false,
      });
      if (live) {
        await live.flushDocs(projectId, []);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to flush project ${projectId} prior to restore: ${err}`,
      );
    }

    const currentNodes = await this.structureService.getAllNodes(projectId);

    // Pre-Restore Safety Guard: Snapshot current state if prisma available to prevent partial restore data loss
    if (this.prisma) {
      try {
        const latestSnap = await this.prisma.manuscriptSnapshot.findFirst({
          where: { projectId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const backupVersion = (latestSnap?.version ?? 0) + 1;
        const backupFiles: Record<string, unknown> = {};
        for (const node of currentNodes) {
          if (node.isFolder()) continue;
          if (node.isDoc() && node.docId) {
            try {
              const doc = await this.docstoreService.getDoc(
                projectId,
                node.docId,
              );
              backupFiles[node.path] = {
                path: node.path,
                type: 'doc',
                docId: node.docId,
                lines: doc.lines || [''],
                hash: doc.hash || '',
                isRootDoc: node.isRootDoc,
              };
            } catch {
              // ignore doc fetch errors during safety backup
            }
          } else if (node.type === 'FILE' && node.fileId) {
            backupFiles[node.path] = {
              path: node.path,
              type: 'file',
              fileId: node.fileId,
              hash: node.hash || '',
              sizeBytes: node.sizeBytes || 0,
            };
          }
        }
        await this.prisma.manuscriptSnapshot.create({
          data: {
            projectId,
            version: backupVersion,
            summary:
              'Pre-restore automatic safety snapshot before restoring to v' +
              snapshot.version,
            isAutomatic: true,
            files:
              Object.keys(backupFiles).length > 0
                ? (backupFiles as Prisma.InputJsonValue)
                : Prisma.JsonNull,
          },
        });
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

    const requiredFolders = new Set<string>();
    for (const filePath of snapshotFiles.keys()) {
      let dir = pathPosix.dirname(filePath);
      while (dir && dir !== '.' && dir !== '/') {
        requiredFolders.add(dir);
        dir = pathPosix.dirname(dir);
      }
    }

    for (const node of currentNodes) {
      if (!node.isFolder() && !snapshotFiles.has(node.path)) {
        try {
          await this.structureService.deleteNode(projectId, node.id);
        } catch (err) {
          this.logger.warn(
            `Could not delete post-snapshot node ${node.path} (${node.id}): ${err}`,
          );
        }
      }
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

    for (const [filePath, fileVo] of snapshotFiles.entries()) {
      const fileName = pathPosix.basename(filePath);
      const parentDir = pathPosix.dirname(filePath);

      if (parentDir && parentDir !== '.' && parentDir !== '/') {
        try {
          await this.structureService.mkdirp(projectId, parentDir);
        } catch (err) {
          this.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
        }
      }

      const existingNode = currentByPath.get(filePath);

      if (fileVo.type === 'doc') {
        let docIdToSync: string | null = null;
        let syncedRev: number | undefined;
        let syncedVersion: number | undefined;
        if (fileVo.docId && this.prisma?.manuscriptDoc?.updateMany) {
          await this.prisma.manuscriptDoc
            .updateMany({
              where: { id: fileVo.docId, projectId },
              data: { deleted: false, deletedAt: null },
            })
            .catch(() => {});
        }
        if (existingNode && existingNode.isDoc() && existingNode.docId) {
          if (this.prisma?.manuscriptDoc?.updateMany) {
            await this.prisma.manuscriptDoc
              .updateMany({
                where: { id: existingNode.docId, projectId },
                data: { deleted: false, deletedAt: null },
              })
              .catch(() => {});
          }
          const updated = await this.docstoreService.updateDoc(
            projectId,
            existingNode.docId,
            {
              lines: fileVo.lines || [''],
            },
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
            await this.structureService.deleteNode(projectId, existingNode.id);
          }

          let targetDocId: string | null = fileVo.docId ?? null;
          if (targetDocId) {
            const updated = await this.docstoreService
              .updateDoc(projectId, targetDocId, {
                lines: fileVo.lines || [''],
              })
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
              lines: fileVo.lines || [''],
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
          if (targetDocId) {
            docIdToSync = targetDocId;
            restoredDocIds.push(targetDocId);
          }

          const newNode = await this.structureService.createNode(projectId, {
            name: fileName,
            path: filePath,
            type: 'DOC',
            docId: targetDocId ?? undefined,
            isRootDoc: fileVo.isRootDoc,
          });

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
              lines: fileVo.lines || [''],
              rev: syncedRev,
              version: syncedVersion,
              source: 'history-restore',
              occurredAt: Date.now(),
            });
          } else {
            try {
              const live = this.moduleRef?.get(LiveCollaborationPort, {
                strict: false,
              });
              if (live) {
                await live.applyExternalText(
                  projectId,
                  docIdToSync,
                  (fileVo.lines || ['']).join('\n'),
                );
              }
            } catch {
              // non-blocking fallback
            }
          }
        }
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        if (this.prisma?.manuscriptFile?.updateMany) {
          await this.prisma.manuscriptFile
            .updateMany({
              where: { id: fileVo.fileId, projectId },
              data: { deleted: false, deletedAt: null },
            })
            .catch(() => {});
        }
        if (existingNode) {
          if (
            existingNode.type !== 'FILE' ||
            existingNode.fileId !== fileVo.fileId
          ) {
            await this.structureService.deleteNode(projectId, existingNode.id);
            await this.structureService.createNode(projectId, {
              name: fileName,
              path: filePath,
              type: 'FILE',
              fileId: fileVo.fileId,
            });
          }
        } else {
          await this.structureService.createNode(projectId, {
            name: fileName,
            path: filePath,
            type: 'FILE',
            fileId: fileVo.fileId,
          });
        }
      }
    }

    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.history.restored',
        projectId,
        version:
          typeof snapshot.version === 'number'
            ? snapshot.version
            : ((snapshot.version as { value?: number } | undefined)?.value ?? 0),
        restoredDocIds,
        occurredAt: Date.now(),
      });
    }

    return {
      restoredFilesCount: snapshotFiles.size,
      restoredDocIds,
    };
  }
}
