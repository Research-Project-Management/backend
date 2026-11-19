/**
 * project-history/adapters/snapshot-restorer.adapter.ts
 * Driven Cross-Context Adapter restoring full page snapshots and individual files.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import * as pathPosix from 'node:path/posix';
import { PrismaService } from '@/core';
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
import { ProjectHistoryRepository } from '../project-history.repository';
import {
  IProjectRestorerPort,
  RestoreResult,
  RestoreSingleFileResult,
  Snapshot,
} from '../domain';
import {
  type RestorerDeps,
  createPreRestoreSafetySnapshot,
  publishOrSyncRestoredDoc,
  restoreOrCreateDoc,
  restoreSingleFileToStateHelper,
  undeleteDocRecord,
  undeleteFileRecord,
} from './single-file-restorer.helper';

@Injectable()
export class PageSnapshotRestorerAdapter extends IProjectRestorerPort {
  private readonly logger = new Logger(PageSnapshotRestorerAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(IDistributedLockPort)
    private readonly lockOrLegacyRef?: IDistributedLockPort | unknown,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly domainEventBus?: PageDomainEventBus,
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
