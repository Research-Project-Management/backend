/**
 * modules/manuscripts/core/services/cleanup.listener.ts
 *
 * Cascading deletion listener for deleted projects to prevent orphaned manuscript rows.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService, RedisCacheService } from '@/core';
import { WorkspaceCollectorService } from './workspace-collector.service';
import { FilestoreRepository } from '../../filestore/filestore.repository';
import { IDocPersistor } from '../../docstore/domain';

interface ProjectDeletedEvent {
  projectId?: string;
  entityId?: string;
}

@Injectable()
export class CleanupListener {
  private readonly logger = new Logger(CleanupListener.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly workspaceCollector?: WorkspaceCollectorService,
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
      let projectFiles: Array<{ id: string; hash: string; storageKey: string; bucketName: string }> = [];

      const [fetchedDocs, fetchedFiles] = await Promise.all([
        this.prisma.pageDoc?.findMany
          ? Promise.resolve(
              this.prisma.pageDoc.findMany({
                where: { spaceId: projectId },
                select: { id: true, inStorage: true, storageKey: true },
              }),
            ).catch(() => [])
          : Promise.resolve([]),
        filestoreRepo && this.prisma.pageFile?.findMany
          ? Promise.resolve(
              this.prisma.pageFile.findMany({
                where: { spaceId: projectId },
                select: {
                  id: true,
                  hash: true,
                  storageKey: true,
                  bucketName: true,
                },
              }),
            ).catch(() => [])
          : Promise.resolve([]),
      ]);

      projectDocs = Array.isArray(fetchedDocs) ? fetchedDocs : [];
      projectFiles = Array.isArray(fetchedFiles) ? fetchedFiles : [];

      if (this.workspaceCollector && projectDocs.length > 0) {
        await Promise.all(
          projectDocs.map((d) =>
            this.workspaceCollector!
              .evictDoc(projectId, d.id)
              .catch(() => undefined),
          ),
        );
      }

      const operations = [
        this.prisma.pageTrackChange.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageCommentThread.deleteMany({ where: { spaceId: projectId } }),
        ...(this.prisma.pageDocReview
          ? [this.prisma.pageDocReview.deleteMany({ where: { spaceId: projectId } })]
          : []),
        this.prisma.pageNode.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageFile.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageSnapshot.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageNotification.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.customDictionaryWord.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageDoc.deleteMany({ where: { spaceId: projectId } }),
        ...(this.prisma.page
          ? [this.prisma.page.deleteMany({ where: { spaceId: projectId } })]
          : []),
      ];
      await this.prisma.$transaction(operations);

      // Garbage-collect cold-tier doc archives in parallel
      if (docPersistor?.deleteObject && projectDocs.length > 0) {
        await Promise.all(
          projectDocs.map((d) =>
            d.inStorage && d.storageKey
              ? Promise.resolve(docPersistor.deleteObject(d.storageKey)).catch(
                  () => undefined,
                )
              : Promise.resolve(),
          ),
        );
      }

      // Garbage-collect unreferenced CAS binary blobs in parallel
      if (filestoreRepo && projectFiles.length > 0) {
        const seenStorageKeys = new Set<string>();
        const uniqueFiles: typeof projectFiles = [];
        for (const f of projectFiles) {
          if (!f.storageKey || seenStorageKeys.has(f.storageKey)) continue;
          seenStorageKeys.add(f.storageKey);
          uniqueFiles.push(f);
        }
        await Promise.all(
          uniqueFiles.map(async (f) => {
            try {
              const remainingRefs = await filestoreRepo.countReferencesByHash(
                f.hash,
              );
              if (remainingRefs === 0) {
                await filestoreRepo.deleteObject(
                  f.bucketName || 'manuscript-files',
                  f.storageKey,
                );
              }
            } catch {
              // Non-blocking CAS GC
            }
          }),
        );
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

/** @deprecated Use CleanupListener */
export { CleanupListener as ManuscriptCleanupListener };
