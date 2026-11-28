/**
 * modules/pages/page/listeners/cleanup.listener.ts
 *
 * Cascading deletion listener for deleted pages and projects to prevent orphaned rows,
 * leaked cold-tier S3 documents, or uncollected CAS binary blobs.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '@/core';
import { WorkspaceCollectorService } from '@/modules/pages/core';
import {
  FilestoreRepository,
  FilestoreService,
} from '@/modules/pages/filestore';
import { IDocPersistor } from '@/modules/pages/docstore';

interface ProjectDeletedEvent {
  projectId?: string;
  entityId?: string;
}

interface PageDeletedEvent {
  projectId: string;
  pageId: string;
  deletedFiles?: Array<{
    id: string;
    sizeBytes?: number;
    blobId?: string | null;
    hash?: string | null;
  }>;
  deletedDocs?: Array<{
    id: string;
    inStorage?: boolean;
    storageKey?: string | null;
  }>;
}

@Injectable()
export class CleanupListener {
  private readonly logger = new Logger(CleanupListener.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly workspaceCollector?: WorkspaceCollectorService,
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

  private resolveFilestoreService(): FilestoreService | undefined {
    try {
      return this.moduleRef?.get(FilestoreService, { strict: false });
    } catch {
      return undefined;
    }
  }

  @OnEvent('pages.page.deleted', { async: true })
  public async handlePageDeleted(event: PageDeletedEvent): Promise<void> {
    if (!event?.projectId) return;
    try {
      if (event.deletedFiles?.length) {
        const filestoreService = this.resolveFilestoreService();
        if (filestoreService?.reclaimDeletedFilesQuotaAndBlobs) {
          const fileIds = event.deletedFiles.map((f) => f.id);
          const deletedNodes = event.deletedFiles.map((f) => ({
            fileId: f.id,
            blobId: f.blobId,
            sizeBytes: f.sizeBytes,
            hash: f.hash,
          }));
          await filestoreService.reclaimDeletedFilesQuotaAndBlobs(
            event.projectId,
            fileIds,
            deletedNodes,
          );
        }
      }

      if (event.deletedDocs?.length) {
        const docPersistor = this.resolveDocPersistor();
        if (docPersistor?.deleteObject) {
          await Promise.all(
            event.deletedDocs.map((d) =>
              d.inStorage && d.storageKey
                ? Promise.resolve(
                    docPersistor.deleteObject(d.storageKey),
                  ).catch(() => undefined)
                : Promise.resolve(),
            ),
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to reclaim blobs/quota/cold-docs for deleted page ${event.pageId}: ${msg}`,
      );
    }
  }

  @OnEvent('project.deleted', { async: true })
  public async handleProjectDeleted(event: ProjectDeletedEvent): Promise<void> {
    const projectId = event?.projectId || event?.entityId;
    if (!projectId) return;

    try {
      this.logger.log(
        `Starting cascading cleanup for deleted project ${projectId} across pages stores...`,
      );

      const filestoreRepo = this.resolveFilestoreRepository();
      const filestoreService = this.resolveFilestoreService();
      const docPersistor = this.resolveDocPersistor();

      let projectDocs: Array<{
        id: string;
        inStorage?: boolean;
        storageKey?: string | null;
      }> = [];
      let projectFiles: Array<{
        id: string;
        sizeBytes?: number;
        blobId?: string | null;
        hash: string;
        storageKey: string;
        bucketName: string;
      }> = [];

      const [fetchedDocs, fetchedFiles] = await Promise.all([
        this.prisma.pageDoc?.findMany
          ? Promise.resolve(
              this.prisma.pageDoc.findMany({
                where: { spaceId: projectId },
                select: { id: true, inStorage: true, storageKey: true },
              }),
            ).catch(() => [])
          : Promise.resolve([]),
        (filestoreRepo || filestoreService) && this.prisma.pageFile?.findMany
          ? Promise.resolve(
              this.prisma.pageFile.findMany({
                where: { spaceId: projectId },
                select: {
                  id: true,
                  sizeBytes: true,
                  blobId: true,
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
            this.workspaceCollector!.evictDoc(projectId, d.id).catch(
              () => undefined,
            ),
          ),
        );
      }

      const operations = [
        this.prisma.docChange.deleteMany({
          where: { doc: { spaceId: projectId } },
        }),
        this.prisma.docComment.deleteMany({
          where: { doc: { spaceId: projectId } },
        }),
        ...(this.prisma.docReview
          ? [
              this.prisma.docReview.deleteMany({
                where: { doc: { spaceId: projectId } },
              }),
            ]
          : []),
        this.prisma.pageNode.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageFile.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.pageSnapshot.deleteMany({ where: { spaceId: projectId } }),
        this.prisma.spellingWord.deleteMany({
          where: { spaceId: projectId },
        }),
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

      // Reclaim SpaceQuota and StorageBlob CAS ref-counts for all purged project files
      if (
        filestoreService?.reclaimDeletedFilesQuotaAndBlobs &&
        projectFiles.length > 0
      ) {
        const fileIds = projectFiles.map((f) => f.id);
        const deletedNodes = projectFiles.map((f) => ({
          fileId: f.id,
          blobId: f.blobId,
          sizeBytes: f.sizeBytes,
          hash: f.hash,
        }));
        await filestoreService
          .reclaimDeletedFilesQuotaAndBlobs(projectId, fileIds, deletedNodes)
          .catch(() => undefined);
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

      this.logger.log(
        `Successfully cascaded cleanup for deleted project ${projectId}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Error during pages cascading cleanup for project ${projectId}: ${err}`,
      );
    }
  }
}
