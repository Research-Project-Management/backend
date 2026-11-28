/**
 * modules/pages/page/services/page.service.ts
 * Public facade for the Page aggregate module: coordinates domain-focused services
 * (Query, Scaffold, Content, File, Trash, Duplicate, Labels) behind a single deep seam.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  PageDomainEventBus,
  hydratePageDocLines,
  resolveActiveProjectId,
  resolveProjectIdByEntityId,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { PageRepository } from '../page.repository';
import {
  PageScaffoldService,
  type CreateProjectPageParams,
} from './scaffold.service';
import { PageQueryService } from './query.service';
import {
  PageContentService,
  type PageDocRanges,
  type UpdatePageContentParams,
  type UpdatePageMetadataParams,
} from './content.service';
import {
  PageFileService,
  type CreatePageFileParams,
  type ImportFromProjectParams,
} from './file.service';
import { PageTrashService } from './trash.service';
import { PageDuplicateService } from './duplicate.service';
import { PageLabelsService } from './labels.service';

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
  private readonly liveCollab: LiveCollaborationPort;
  private readonly queryService: PageQueryService;
  private readonly contentService: PageContentService;
  private readonly fileService: PageFileService;
  private readonly trashService: PageTrashService;
  private readonly duplicateService: PageDuplicateService;
  private readonly labelsService: PageLabelsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    private readonly projectPageScaffoldService: PageScaffoldService,
    @Optional() eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional() domainEventBus?: PageDomainEventBus,
    @Optional()
    @Inject(FILES_PORT)
    filesPort?: IFilesPort,
    @Optional() pageRepo?: PageRepository,
    @Optional() queryService?: PageQueryService,
    @Optional() contentService?: PageContentService,
    @Optional() fileService?: PageFileService,
    @Optional() trashService?: PageTrashService,
    @Optional() duplicateService?: PageDuplicateService,
    @Optional() labelsService?: PageLabelsService,
  ) {
    const resolvedScopeRepo = pageScopeRepo ?? new ScopeRepository(prisma);
    const resolvedPageRepo = pageRepo ?? new PageRepository(prisma);
    const resolvedLiveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
    const resolvedEventBus =
      domainEventBus ?? new PageDomainEventBus(resolvedLiveCollab);

    this.liveCollab = resolvedLiveCollab;
    this.queryService =
      queryService ??
      new PageQueryService(prisma, docstoreService, resolvedLiveCollab);
    this.contentService =
      contentService ??
      new PageContentService(
        prisma,
        docstoreService,
        resolvedPageRepo,
        resolvedScopeRepo,
        resolvedLiveCollab,
        resolvedEventBus,
        eventEmitter,
      );
    this.fileService =
      fileService ??
      new PageFileService(
        prisma,
        docstoreService,
        resolvedLiveCollab,
        eventEmitter,
        filesPort,
      );
    this.trashService =
      trashService ??
      new PageTrashService(
        prisma,
        docstoreService,
        resolvedScopeRepo,
        resolvedEventBus,
        eventEmitter,
      );
    this.duplicateService =
      duplicateService ??
      new PageDuplicateService(
        prisma,
        docstoreService,
        resolvedScopeRepo,
        resolvedLiveCollab,
        eventEmitter,
        filesPort,
      );
    this.labelsService =
      labelsService ??
      new PageLabelsService(prisma, resolvedPageRepo, resolvedScopeRepo);
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

  public getPageById(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.queryService.getPageById(pageId, authorizedProjectId);
  }

  public createProjectPage(
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

  public getProjectPages(
    projectId: string,
    query?: { status?: string; search?: string },
  ) {
    return this.queryService.getProjectPages(projectId, query);
  }

  public updatePageContent(
    docId: string,
    body: UpdatePageContentParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.contentService.updatePageContent(
      docId,
      body,
      authorizedProjectId,
    );
  }

  public updatePageMetadata(
    pageId: string,
    body: UpdatePageMetadataParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.contentService.updatePageMetadata(
      pageId,
      body,
      authorizedProjectId,
    );
  }

  public updateThumbnail(
    pageId: string,
    pdfThumbnail: string = '',
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.contentService.updateThumbnail(
      pageId,
      pdfThumbnail,
      authorizedProjectId,
    );
  }

  public getPageFiles(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
    options?: { includeContent?: boolean },
  ) {
    return this.queryService.getPageFiles(pageId, authorizedProjectId, options);
  }

  public createPageFile(
    pageId: string,
    body: CreatePageFileParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.fileService.createPageFile(pageId, body, authorizedProjectId);
  }

  public importFileFromProject(
    targetProjectOrPageId: string,
    body: ImportFromProjectParams,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string | null,
  ) {
    return this.fileService.importFileFromProject(
      targetProjectOrPageId,
      body,
      authorizedProjectId,
      userId,
    );
  }

  public deletePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.trashService.deletePage(pageId, authorizedProjectId);
  }

  public getDeletedFiles(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.trashService.getDeletedFiles(pageId, authorizedProjectId);
  }

  public getTrashPages(spaceId: string) {
    return this.trashService.getTrashPages(spaceId);
  }

  public purgePagePermanently(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.trashService.purgePagePermanently(pageId, authorizedProjectId);
  }

  public restorePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return this.trashService.restorePage(pageId, authorizedProjectId);
  }

  public duplicatePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string | null,
  ) {
    return this.duplicateService.duplicatePage(
      pageId,
      authorizedProjectId,
      userId,
    );
  }

  public getPageLabels(projectId: string, pageId: string) {
    return this.labelsService.getPageLabels(projectId, pageId);
  }

  public assignPageLabels(
    projectId: string,
    pageId: string,
    labelIds?: string[],
  ) {
    return this.labelsService.assignPageLabels(projectId, pageId, labelIds);
  }

  public removePageLabel(projectId: string, pageId: string, labelId: string) {
    return this.labelsService.removePageLabel(projectId, pageId, labelId);
  }
}
