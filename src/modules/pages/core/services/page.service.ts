/**
 * modules/pages/core/services/page.service.ts
 * Domain Service managing ManuscriptPage aggregate lifecycle (CRUD, duplicate,
 * trash/restore, labels, thumbnail, settings), ensuring page.id === rootDoc.id on creation.
 */

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../ports/live-collaboration.port';
import { PageDomainEventBus } from '../events/event-bus.service';
import {
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveProjectIdByEntityId,
} from '../page-scope.helper';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import {
  PageScaffoldService,
  CreateProjectPageParams,
} from '@/modules/pages/docstore/services/page-scaffold.service';
import {
  hydratePageDocLines,
  findPageRecordWithNode,
  formatPageByIdResponse,
} from '@/modules/pages/docstore/services/doc-occ.helper';
import {
  PageDocRanges,
  updateProjectThumbnailSettings,
  resolvePageFilesList,
  resolveAndAssignLabelsForDoc,
} from './page-query-metadata.helper';
import { restoreDeletedDocOrFile } from './page-trash-clone.helper';
import {
  type PageLifecycleContext,
  type UpdatePageContentParams,
  deletePageHelper,
  duplicatePageHelper,
  getProjectPagesHelper,
  updatePageContentHelper,
} from './page-lifecycle.helper';
import {
  type CreatePageFileParams,
  type ImportFromProjectParams,
  type PageFilesTransferContext,
  createPageFileHelper,
  getDeletedFilesHelper,
  importFileFromProjectHelper,
} from './page-files-transfer.helper';

export type {
  CreatePageFileParams,
  CreateProjectPageParams,
  ImportFromProjectParams,
  PageDocRanges,
  UpdatePageContentParams,
};

@Injectable()
export class PageService {
  private readonly logger = new Logger(PageService.name);
  private readonly liveCollab: LiveCollaborationPort;
  private readonly domainEventBus: PageDomainEventBus;
  private readonly pageScopeRepo: ScopeRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    private readonly projectPageScaffoldService: PageScaffoldService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional() domainEventBus?: PageDomainEventBus,
  ) {
    this.pageScopeRepo = pageScopeRepo || new ScopeRepository(prisma);
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
    this.domainEventBus =
      domainEventBus ?? new PageDomainEventBus(this.liveCollab);
  }

  private getLifecycleContext(): PageLifecycleContext {
    return {
      prisma: this.prisma,
      docstoreService: this.docstoreService,
      pageScopeRepo: this.pageScopeRepo,
      liveCollab: this.liveCollab,
      domainEventBus: this.domainEventBus,
      logger: this.logger,
      eventEmitter: this.eventEmitter,
    };
  }

  private getTransferContext(): PageFilesTransferContext {
    return {
      prisma: this.prisma,
      docstoreService: this.docstoreService,
      liveCollab: this.liveCollab,
      eventEmitter: this.eventEmitter,
    };
  }

  public getDomainEventBus(): PageDomainEventBus {
    return this.domainEventBus;
  }

  public getLiveCollaboration(): LiveCollaborationPort {
    return this.liveCollab;
  }

  public async resolveProjectId(id: string): Promise<string | null> {
    return resolveProjectIdByEntityId(this.prisma, id);
  }

  public resolveActiveProjectId(
    project?: string | { id: string } | null,
  ): string | undefined {
    return resolveActiveProjectId(project);
  }

  public async getHydratedDocLines(doc: {
    id: string;
    spaceId?: string;
    projectId?: string;
    lines: unknown;
    inStorage?: boolean;
  }): Promise<string[]> {
    return hydratePageDocLines(this.docstoreService, doc);
  }

  /**
   * 1. GET PAGE BY ID
   */
  public async getPageById(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    try {
      const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
      const record = await findPageRecordWithNode(
        this.prisma,
        pageId,
        targetProjectId,
      );

      if (!record || isRecordDeleted(record)) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const recordProjectId = getRecordSpaceId(record);
      const live = this.getLiveCollaboration();
      if (live && recordProjectId) {
        const flushed = await live
          .flushDocs(recordProjectId, [pageId])
          .catch(() => []);
        if (flushed.length > 0) {
          const refreshed = await findPageRecordWithNode(
            this.prisma,
            pageId,
            recordProjectId,
          );
          if (refreshed && !isRecordDeleted(refreshed)) {
            return await formatPageByIdResponse(
              this.docstoreService,
              refreshed,
            );
          }
        }
      }

      return await formatPageByIdResponse(this.docstoreService, record);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException(`Document ${pageId} not found`);
    }
  }

  /**
   * 2. CREATE PROJECT PAGE
   * Ensures page.id === rootDoc.id for 100% backward compatibility
   */
  public async createProjectPage(
    projectId: string,
    body: CreateProjectPageParams,
    userId: string | null,
  ) {
    return this.projectPageScaffoldService.createProjectPage(
      projectId,
      body,
      userId,
    );
  }

  /**
   * 3. GET PROJECT PAGES
   */
  public async getProjectPages(
    projectId: string,
    query?: { status?: string; search?: string },
  ) {
    return await getProjectPagesHelper(
      this.getLifecycleContext(),
      projectId,
      query,
    );
  }

  /**
   * 4. UPDATE PAGE CONTENT & METADATA
   */
  public async updatePageContent(
    docId: string,
    body: UpdatePageContentParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return await updatePageContentHelper(
      this.getLifecycleContext(),
      docId,
      body,
      authorizedProjectId,
    );
  }

  /**
   * 5. UPDATE THUMBNAIL
   */
  public async updateThumbnail(
    pageId: string,
    pdfThumbnail: string = '',
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (isUuid(pageId)) {
      try {
        const targetProjectId =
          this.resolveActiveProjectId(authorizedProjectId);
        const record = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
          : await this.prisma.pageDoc.findUnique({
              where: { id: pageId },
              select: { id: true, spaceId: true, ranges: true },
            });

        let projectId = getRecordSpaceId(record) || null;

        if (record) {
          const existingRanges = (record.ranges as PageDocRanges) || {};
          await this.prisma.pageDoc
            .update({
              where: { id: pageId },
              data: {
                ranges: {
                  ...existingRanges,
                  pdfThumbnail,
                },
              },
            })
            .catch(() => null);
        } else {
          projectId = await this.resolveProjectId(pageId);
        }

        if (projectId) {
          await updateProjectThumbnailSettings(
            this.prisma,
            projectId,
            pdfThumbnail,
          );
        }
      } catch {
        // Non-blocking fallback
      }
    }

    return {
      page: {
        id: pageId,
        pdfThumbnail,
      },
    };
  }

  /**
   * 6. GET PAGE FILES
   */
  public async getPageFiles(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
    options?: { includeContent?: boolean },
  ) {
    try {
      if (!isUuid(pageId)) {
        return { files: [] };
      }
      const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
      const live = this.getLiveCollaboration();
      if (live) {
        const resolvedProjectId =
          targetProjectId ?? (await this.resolveProjectId(pageId));
        if (resolvedProjectId) {
          await live.flushDocs(resolvedProjectId, []).catch(() => []);
        }
      }
      return await resolvePageFilesList(
        this.prisma,
        this.docstoreService,
        pageId,
        targetProjectId,
        options,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw err;
      }
      return { files: [] };
    }
  }

  /**
   * 7. CREATE PAGE FILE
   */
  public async createPageFile(
    pageId: string,
    body: CreatePageFileParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return await createPageFileHelper(
      this.getTransferContext(),
      pageId,
      body,
      authorizedProjectId,
    );
  }

  /**
   * 8. DELETE PAGE
   */
  public async deletePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return await deletePageHelper(
      this.getLifecycleContext(),
      pageId,
      authorizedProjectId,
    );
  }

  /**
   * 9. GET DELETED FILES
   */
  public async getDeletedFiles(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return await getDeletedFilesHelper(
      this.prisma,
      pageId,
      authorizedProjectId,
    );
  }

  /**
   * 10. RESTORE PAGE / FILE
   */
  public async restorePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    return restoreDeletedDocOrFile(
      this.prisma,
      this.docstoreService,
      this.eventEmitter,
      pageId,
      targetProjectId,
    );
  }

  /**
   * 11. DUPLICATE PAGE (Full Aggregate Root + Virtual Tree Deep Clone)
   */
  public async duplicatePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string | null,
  ) {
    return await duplicatePageHelper(
      this.getLifecycleContext(),
      pageId,
      authorizedProjectId,
      userId,
    );
  }

  /**
   * 12. LABELS MANAGEMENT
   */
  public async getPageLabels(projectId: string, pageId: string) {
    if (isUuid(pageId)) {
      const doc = await this.pageScopeRepo.findDocInProject(projectId, pageId);
      const ranges = (
        doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
      ) as PageDocRanges;
      const labels = ranges.labels || [];
      return { labels };
    }
    return { labels: [] };
  }

  public async assignPageLabels(
    projectId: string,
    pageId: string,
    labelIds?: string[],
  ) {
    if (isUuid(pageId) && Array.isArray(labelIds)) {
      return resolveAndAssignLabelsForDoc(
        this.prisma,
        this.pageScopeRepo,
        projectId,
        pageId,
        labelIds,
      );
    }
    return { labels: [] };
  }

  public async removePageLabel(
    projectId: string,
    pageId: string,
    labelId: string,
  ) {
    if (isUuid(pageId)) {
      const doc = await this.pageScopeRepo.findDocInProject(projectId, pageId);
      if (!doc) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const ranges = (
        doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
      ) as PageDocRanges;
      const labels = (ranges.labels || []).filter((l) => l.id !== labelId);
      const labelIds = (ranges.labelIds || []).filter(
        (id: string) => id !== labelId,
      );
      await this.pageScopeRepo.updateDocInProject(projectId, pageId, {
        ranges: { labelIds, labels },
      });
      return { labels };
    }
    return { labels: [] };
  }

  /**
   * 13. IMPORT FILE / DOC FROM ANOTHER PROJECT
   */
  public async importFileFromProject(
    targetProjectOrPageId: string,
    body: ImportFromProjectParams,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string | null,
  ) {
    return await importFileFromProjectHelper(
      this.getTransferContext(),
      targetProjectOrPageId,
      body,
      authorizedProjectId,
      userId,
    );
  }
}
