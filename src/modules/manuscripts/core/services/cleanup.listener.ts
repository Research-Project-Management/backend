/**
 * modules/manuscripts/core/services/cleanup.listener.ts
 *
 * Cascading deletion listener for deleted projects to prevent orphaned manuscript rows.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService, RedisCacheService } from '@/core';
import { ProjectWorkspaceCollectorService } from './workspace-collector.service';
import { FilestoreRepository } from '../../filestore/filestore.repository';
import { IDocPersistor } from '../../docstore/domain';

interface ProjectDeletedEvent {
  projectId?: string;
  entityId?: string;
}

@Injectable()
export class ManuscriptCleanupListener {
  private readonly logger = new Logger(ManuscriptCleanupListener.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly workspaceCollector?: ProjectWorkspaceCollectorService,
    @Optional()
    private readonly redis?: RedisCacheService,
    @Optional()
    private readonly filestoreRepository?: FilestoreRepository,
    @Optional()
    private readonly docPersistor?: IDocPersistor,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  private resolveFilestoreRepository(): FilestoreRepository | undefined {
    if (this.filestoreRepository) return this.filestoreRepository;
    try {
      return this.moduleRef?.get(FilestoreRepository, { strict: false });
    } catch {
      return undefined;
    }
  }

  private resolveDocPersistor(): IDocPersistor | undefined {
    if (this.docPersistor) return this.docPersistor;
    try {
      return this.moduleRef?.get(IDocPersistor, { strict: false });
    } catch {
      return undefined;
    }
  }

  @OnEvent('project.deleted', { async: true })
  public async handleProjectDeleted(event: ProjectDeletedEvent): Promise<void> {
    const projectId = event?.projectId || event?.entityId;
    if (!projectId) return;

    try {
      this.logger.log(
        `Starting cascading cleanup for deleted project ${projectId} across manuscript stores...`,
      );

      const filestoreRepo = this.resolveFilestoreRepository();
      const docPersistor = this.resolveDocPersistor();

      let projectDocs: Array<{ id: string; inStorage?: boolean; storageKey?: string | null }> = [];
      if (this.prisma.manuscriptDoc?.findMany) {
        try {
          projectDocs = await this.prisma.manuscriptDoc.findMany({
            where: { projectId },
            select: { id: true, inStorage: true, storageKey: true },
          });
          if (this.workspaceCollector && Array.isArray(projectDocs) && projectDocs.length > 0) {
            await Promise.all(
              projectDocs.map((d) =>
                this.workspaceCollector!
                  .evictDoc(projectId, d.id)
                  .catch(() => undefined),
              ),
            );
          }
        } catch {
          // Non-blocking Yjs eviction before DB cleanup
        }
      }

      let projectFiles: Array<{ id: string; hash: string; storageKey: string; bucketName: string }> = [];
      if (filestoreRepo && this.prisma.manuscriptFile?.findMany) {
        try {
          projectFiles = await this.prisma.manuscriptFile.findMany({
            where: { projectId },
            select: { id: true, hash: true, storageKey: true, bucketName: true },
          });
        } catch {
          // Non-blocking file lookup before DB cleanup
        }
      }

      const operations = [
        this.prisma.manuscriptTrackChange.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptCommentThread.deleteMany({ where: { projectId } }),
        ...(this.prisma.manuscriptDocReview
          ? [this.prisma.manuscriptDocReview.deleteMany({ where: { projectId } })]
          : []),
        ...(this.prisma.manuscriptLinkedFile
          ? [this.prisma.manuscriptLinkedFile.deleteMany({ where: { projectId } })]
          : []),
        this.prisma.manuscriptNode.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptFile.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptSnapshot.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptNotification.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptCustomWord.deleteMany({ where: { projectId } }),
        this.prisma.manuscriptDoc.deleteMany({ where: { projectId } }),
      ];
      await this.prisma.$transaction(operations);

      // Garbage-collect cold-tier doc archives
      if (docPersistor?.deleteObject && projectDocs.length > 0) {
        for (const d of projectDocs) {
          if (d.inStorage && d.storageKey) {
            await Promise.resolve(docPersistor.deleteObject(d.storageKey)).catch(
              () => undefined,
            );
          }
        }
      }

      // Garbage-collect unreferenced CAS binary blobs
      if (filestoreRepo && projectFiles.length > 0) {
        const seenStorageKeys = new Set<string>();
        for (const f of projectFiles) {
          if (!f.storageKey || seenStorageKeys.has(f.storageKey)) continue;
          seenStorageKeys.add(f.storageKey);
          try {
            const remainingRefs = await filestoreRepo.countReferencesByHash(f.hash);
            if (remainingRefs === 0) {
              await filestoreRepo.deleteObject(
                f.bucketName || 'manuscript-files',
                f.storageKey,
              );
            }
          } catch {
            // Non-blocking CAS GC
          }
        }
      }

      if (this.redis?.isReady?.()) {
        await this.redis
          .getClient()
          ?.del(`manuscript:linked_files:${projectId}`)
          ?.catch(() => undefined);
      }

      this.logger.log(
        `Successfully cascaded cleanup for deleted project ${projectId}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Error during manuscript cascading cleanup for project ${projectId}: ${err}`,
      );
    }
  }
}
