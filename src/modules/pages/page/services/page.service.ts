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
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../../core/ports/live-collaboration.port';
import { PageDomainEventBus } from '../../core/events/event-bus.service';
import {
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveProjectIdByEntityId,
} from '../../core/utils/page-scope';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import {
  PageScaffoldService,
  CreateProjectPageParams,
} from './scaffold.service';
import {
  hydratePageDocLines,
  findPageRecordWithNode,
  formatPageByIdResponse,
} from '@/modules/pages/core/utils/doc-occ.helper';
import { PageRepository } from '../page.repository';
import { getProjectPagesHelper, resolvePageFilesList } from './query.service';
import {
  type PageDocRanges,
  type PageLifecycleContext,
  type UpdatePageContentParams,
  type UpdatePageMetadataParams,
  updatePageContentHelper,
  updatePageMetadataHelper,
} from './content.service';
import {
  type CreatePageFileParams,
  type ImportFromProjectParams,
  type PageFilesTransferContext,
  createPageFileHelper,
  importFileFromProjectHelper,
} from './file.service';
import {
  deletePageHelper,
  getDeletedFilesHelper,
  getTrashPagesHelper,
  purgePagePermanentlyHelper,
  restoreDeletedDocOrFile,
} from './trash.service';
import { duplicatePageHelper } from './duplicate.service';
import { resolveAndAssignLabelsForDoc } from './labels.service';

export type {
  CreatePageFileParams,
  CreateProjectPageParams,
  ImportFromProjectParams,
  PageDocRanges,
  UpdatePageContentParams,
  UpdatePageMetadataParams,
};

@Injectable()
export class PageService {
  private readonly logger = new Logger(PageService.name);
  private readonly liveCollab: LiveCollaborationPort;
  private readonly domainEventBus: PageDomainEventBus;
  private readonly pageScopeRepo: ScopeRepository;
  private readonly pageRepo: PageRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    private readonly projectPageScaffoldService: PageScaffoldService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional() domainEventBus?: PageDomainEventBus,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
    @Optional() pageRepo?: PageRepository,
  ) {
    this.pageScopeRepo = pageScopeRepo ?? new ScopeRepository(prisma);
    this.pageRepo = pageRepo ?? new PageRepository(prisma);
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
    this.domainEventBus =
      domainEventBus ?? new PageDomainEventBus(this.liveCollab);
  }

  private getLifecycleContext(): PageLifecycleContext {
    return {
      prisma: this.prisma,
      pageRepo: this.pageRepo,
      docstoreService: this.docstoreService,
      pageScopeRepo: this.pageScopeRepo,
      liveCollab: this.liveCollab,
      domainEventBus: this.domainEventBus,
      logger: this.logger,
      eventEmitter: this.eventEmitter,
      filesPort: this.filesPort,
    };
  }

  private getTransferContext(): PageFilesTransferContext {
    return {
      prisma: this.prisma,
      pageRepo: this.pageRepo,
      docstoreService: this.docstoreService,
      liveCollab: this.liveCollab,
      eventEmitter: this.eventEmitter,
      filesPort: this.filesPort,
    };
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

  public async updatePageMetadata(
    pageId: string,
    body: UpdatePageMetadataParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return await updatePageMetadataHelper(
      this.getLifecycleContext(),
      pageId,
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
        const directPage = targetProjectId
          ? await this.pageRepo.findActivePageInSpace(targetProjectId, pageId)
          : null;
        let canonicalPageId = directPage?.id;
        if (!canonicalPageId) {
          const record = targetProjectId
            ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
            : await this.prisma.pageDoc.findUnique({
                where: { id: pageId },
                select: { id: true, pageId: true, spaceId: true },
              });
          canonicalPageId = record?.pageId || pageId;
        }
        await this.pageRepo
          .updatePageThumbnail(canonicalPageId, pdfThumbnail, targetProjectId)
          .catch(() => null);
      } catch {
        // Non-blocking thumbnail persistence
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

  public async getTrashPages(spaceId: string) {
    return await getTrashPagesHelper(this.prisma, spaceId);
  }

  public async purgePagePermanently(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return await purgePagePermanentlyHelper(
      this.getLifecycleContext(),
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
      this.filesPort,
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
      const ownedPage = await this.pageRepo.findActivePageInSpace(
        projectId,
        pageId,
      );
      let canonicalPageId = ownedPage?.id ?? null;
      if (!canonicalPageId) {
        const doc = await this.pageScopeRepo.findDocInProject(
          projectId,
          pageId,
        );
        canonicalPageId = doc?.pageId || null;
      }
      if (!canonicalPageId) {
        return { labels: [] };
      }
      const labels = await this.pageRepo.findPageLabels(canonicalPageId);
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
        this.pageRepo,
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
      const ownedPage = await this.pageRepo.findActivePageInSpace(
        projectId,
        pageId,
      );
      let canonicalPageId = ownedPage?.id ?? null;
      if (!canonicalPageId) {
        const doc = await this.pageScopeRepo.findDocInProject(
          projectId,
          pageId,
        );
        if (!doc) {
          throw new NotFoundException({
            statusCode: 404,
            code: 'RESOURCE_NOT_FOUND',
            message: `Page ${pageId} not found`,
          });
        }
        canonicalPageId = doc.pageId || pageId;
      }

      await this.pageRepo.removePageLabel(canonicalPageId, labelId);
      const labels = await this.pageRepo.findPageLabels(canonicalPageId);
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
