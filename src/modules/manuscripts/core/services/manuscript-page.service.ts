/**
 * modules/manuscripts/core/services/manuscript-page.service.ts
 * Domain Service managing ManuscriptPage aggregate lifecycle (CRUD, duplicate,
 * trash/restore, labels, thumbnail, settings), ensuring page.id === rootDoc.id on creation.
 */

import {
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { LiveCollaborationPort, ManuscriptDomainEventBus } from '@/modules/manuscripts/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { ManuscriptPageScopeRepository } from '@/modules/manuscripts/docstore/repositories/manuscript-page-scope.repository';
import {
  ManuscriptProjectBootstrapService,
  CreateProjectPageParams,
} from '@/modules/manuscripts/docstore/services/manuscript-project-bootstrap.service';
import {
  PageDocRanges,
  resolveActiveProjectId,
  resolveProjectIdByEntityId,
  hydratePageDocLines,
  findPageRecordWithNode,
  formatPageByIdResponse,
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
  applyPageMetadataAndTitleUpdates,
  updateProjectThumbnailSettings,
  resolvePageFilesList,
  formatRootNodesAsProjectPages,
  restoreDeletedDocOrFile,
  duplicateSourcePageAndNode,
  resolveAndAssignLabelsForDoc,
  isPrismaUniqueConstraintError,
} from '@/modules/manuscripts/docstore/controllers/pages-doc.helpers';

export interface UpdatePageContentParams {
  content?: string;
  lines?: string[];
  title?: string;
  version?: number;
  expectedRev?: number;
  expectedVersion?: number;
  status?: 'draft' | 'published' | 'archived';
  description?: string;
}

export interface CreatePageFileParams {
  title?: string;
  name?: string;
  content?: string;
}

export type { CreateProjectPageParams, PageDocRanges };

@Injectable()
export class ManuscriptPageService {
  private readonly logger = new Logger(ManuscriptPageService.name);
  private liveCollab: LiveCollaborationPort | null | undefined;
  private domainEventBusInstance: ManuscriptDomainEventBus | null | undefined;
  private readonly pageScopeRepo: ManuscriptPageScopeRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    private readonly projectBootstrapService: ManuscriptProjectBootstrapService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() pageScopeRepo?: ManuscriptPageScopeRepository,
    @Optional() private readonly domainEventBus?: ManuscriptDomainEventBus,
  ) {
    this.pageScopeRepo =
      pageScopeRepo || new ManuscriptPageScopeRepository(prisma);
  }

  public getDomainEventBus(): ManuscriptDomainEventBus | null {
    if (this.domainEventBus) return this.domainEventBus;
    if (this.domainEventBusInstance !== undefined) return this.domainEventBusInstance;
    try {
      this.domainEventBusInstance =
        this.moduleRef?.get(ManuscriptDomainEventBus, { strict: false }) ?? null;
    } catch {
      this.domainEventBusInstance = null;
    }
    return this.domainEventBusInstance;
  }

  public getLiveCollaboration(): LiveCollaborationPort | null {
    if (this.liveCollab !== undefined) return this.liveCollab;
    try {
      this.liveCollab =
        this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null;
    } catch {
      this.liveCollab = null;
    }
    return this.liveCollab;
  }

  public async syncLiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
  ): Promise<boolean> {
    const live = this.getLiveCollaboration();
    if (!live) return false;
    try {
      return await live.applyExternalText(projectId, docId, lines.join('\n'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to sync REST write into live session ${projectId}:${docId}: ${message}`,
      );
      return false;
    }
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
    projectId: string;
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

      if (!record || record.deleted) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const live = this.getLiveCollaboration();
      if (live && record.projectId) {
        const flushed = await live
          .flushDocs(record.projectId, [pageId])
          .catch(() => []);
        if (flushed.length > 0) {
          const refreshed = await findPageRecordWithNode(
            this.prisma,
            pageId,
            record.projectId,
          );
          if (refreshed && !refreshed.deleted) {
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
    return this.projectBootstrapService.createProjectPage(
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
    if (!isUuid(projectId)) {
      return { pages: [], total: 0, isEmpty: true };
    }
    try {
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(projectId, []).catch(() => []);
      }
      const [rootNodes, project] = await Promise.all([
        this.prisma.manuscriptNode.findMany({
          where: {
            projectId,
            isRootDoc: true,
            OR: [{ docId: null }, { doc: { deleted: false } }],
          },
          include: { doc: true },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: {
            id: true,
            createdBy: {
              select: {
                id: true,
                email: true,
                profile: { select: { name: true } },
              },
            },
          },
        }),
      ]);

      const authorName =
        project?.createdBy?.profile?.name ||
        project?.createdBy?.email?.split('@')[0] ||
        'Author';

      const pages = await formatRootNodesAsProjectPages(
        this.docstoreService,
        projectId,
        authorName,
        rootNodes,
        query?.search,
      );

      return {
        pages,
        total: pages.length,
        isEmpty: pages.length === 0,
      };
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      this.logger.error(`Error fetching docs for project ${projectId}`, err);
      throw new InternalServerErrorException(
        'Failed to fetch project documents and pages',
      );
    }
  }

  /**
   * 4. UPDATE PAGE CONTENT & METADATA
   */
  public async updatePageContent(
    pageId: string,
    body: UpdatePageContentParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    const record = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
      : await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });

    if (!record || record.deleted) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${pageId} not found`,
      });
    }

    assertExpectedVersionAndRev(record, body.expectedRev, body.expectedVersion);

    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';
    if (!hasNewContent && record.projectId) {
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(record.projectId, [pageId]).catch(() => []);
      }
    }
    const lines = hasNewContent
      ? body.lines ||
        (typeof body.content === 'string' ? body.content.split('\n') : [])
      : await this.getHydratedDocLines(record);

    const result = await executeDocstoreUpdateWithOcc(
      this.docstoreService,
      record,
      lines,
      body.version,
      body.expectedRev ?? record.rev,
    );

    const { cleanTitle, existingRanges } =
      await applyPageMetadataAndTitleUpdates(this.prisma, pageId, record, body);

    const updatedLines = result.doc.lines || [];
    const content = Array.isArray(updatedLines)
      ? updatedLines.join('\n')
      : String(updatedLines);

    if (this.eventEmitter && record.projectId) {
      try {
        this.eventEmitter.emit('manuscripts.project.event', {
          projectId: record.projectId,
          event: 'doc:content-updated',
          payload: {
            docId: pageId,
            version: result.doc.version,
            rev: result.doc.rev,
            content,
            updatedAt: new Date().toISOString(),
          },
        });
      } catch {
        // Non-blocking real-time broadcast error ignored
      }
    }

    let liveSynced = false;
    if (hasNewContent && record.projectId) {
      const bus = this.getDomainEventBus();
      if (bus) {
        try {
          await bus.publish({
            type: 'manuscript.document.mutated',
            projectId: record.projectId,
            docId: pageId,
            lines: result.doc.lines || [''],
            rev: result.doc.rev,
            version: result.doc.version,
            source: 'rest-docstore',
            occurredAt: Date.now(),
          });
          liveSynced = true;
        } catch (busErr) {
          this.logger.warn(
            `Failed to publish manuscript.document.mutated event for doc ${pageId}: ${String(busErr)}`,
          );
          liveSynced = await this.syncLiveDoc(
            record.projectId,
            pageId,
            result.doc.lines || lines,
          );
        }
      } else {
        liveSynced = await this.syncLiveDoc(
          record.projectId,
          pageId,
          result.doc.lines || lines,
        );
      }
    }

    return {
      ...result,
      rev: result.rev,
      liveSessionSynced: liveSynced,
      page: {
        id: result.doc.id,
        title: cleanTitle || result.doc.path?.replace(/^\//, '') || 'main.tex',
        description: body.description ?? existingRanges.description ?? '',
        content,
        status: body.status || existingRanges.status || 'published',
        projectId: record.projectId,
        version: result.doc.version,
        rev: result.doc.rev,
        updatedAt: new Date().toISOString(),
      },
    };
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
          : await this.prisma.manuscriptDoc.findUnique({
              where: { id: pageId },
              select: { id: true, projectId: true, ranges: true },
            });

        let projectId = record?.projectId || null;

        if (record) {
          const existingRanges = (record.ranges as PageDocRanges) || {};
          await this.prisma.manuscriptDoc
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
    const fileName = body?.title || body?.name || 'untitled.tex';
    const cleanName = fileName.trim().replace(/^\//, '');
    const content = body?.content || '';

    let projectId: string | null =
      this.resolveActiveProjectId(authorizedProjectId) || null;
    const parentDocId = pageId;

    if (!projectId && isUuid(pageId)) {
      const record = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });
      if (record) {
        projectId = record.projectId;
      } else {
        const project = await this.prisma.project.findUnique({
          where: { id: pageId },
        });
        if (project) {
          projectId = project.id;
        }
      }
    }

    if (!projectId) {
      throw new NotFoundException(
        `Project not found for document or page ${pageId}`,
      );
    }

    const cleanDocPath = cleanName.replace(/\\/g, '/').replace(/^\/+/g, '');
    const cleanNodePath = `/${cleanDocPath}`;

    let createdDocResult: Awaited<ReturnType<typeof this.docstoreService.createDoc>>;
    let createdNodeResult: { id: string };

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const doc = await this.docstoreService.createDoc(projectId, {
          path: cleanDocPath,
          text: content,
          version: 1,
          tx,
        });

        const node = await tx.manuscriptNode.create({
          data: {
            projectId,
            name: cleanName,
            path: cleanNodePath,
            type: 'DOC',
            docId: doc._id,
            sizeBytes: Buffer.byteLength(content, 'utf8'),
          },
        });

        return { doc, node };
      });

      createdDocResult = txResult.doc;
      createdNodeResult = txResult.node;
    } catch (createErr: unknown) {
      if (isPrismaUniqueConstraintError(createErr)) {
        throw new BadRequestException(
          `File path already exists: ${cleanNodePath}`,
        );
      }
      throw createErr;
    }

    const createdDoc = createdDocResult;
    const nodeId = createdNodeResult.id;

    return {
      file: {
        id: createdDoc._id,
        nodeId,
        title: cleanName,
        name: cleanName,
        path: `/${cleanName}`,
        type: 'file',
        pageId: parentDocId,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * 8. DELETE PAGE
   */
  public async deletePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (isUuid(pageId)) {
      try {
        const targetProjectId =
          this.resolveActiveProjectId(authorizedProjectId);
        const doc = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
          : await this.prisma.manuscriptDoc.findUnique({
              where: { id: pageId },
            });
        if (doc) {
          await Promise.all([
            this.docstoreService.patchDoc(doc.projectId, doc.id, {
              deleted: true,
              deletedAt: new Date().toISOString(),
            }),
            this.prisma.manuscriptNode
              .deleteMany({
                where: {
                  projectId: doc.projectId,
                  OR: [{ docId: doc.id }, { id: pageId }],
                },
              })
              .catch(() => null),
          ]);
          const live = this.getLiveCollaboration();
          if (live) {
            await live.evictDoc(doc.projectId, doc.id).catch(() => null);
          }
        }
      } catch {
        // Fallback
      }
    }
    return { success: true };
  }

  /**
   * 9. GET DELETED FILES
   */
  public async getDeletedFiles(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    let projectId: string | null =
      this.resolveActiveProjectId(authorizedProjectId) || null;
    if (!projectId && isUuid(pageId)) {
      const doc = await this.prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
        select: { projectId: true },
      });
      if (doc) {
        projectId = doc.projectId;
      } else {
        const project = await this.prisma.project.findUnique({
          where: { id: pageId },
          select: { id: true },
        });
        if (project) projectId = project.id;
      }
    }

    if (!projectId) {
      return { files: [] };
    }

    const [deletedDocs, deletedFiles] = await Promise.all([
      this.prisma.manuscriptDoc.findMany({
        where: { projectId, deleted: true },
        select: {
          id: true,
          path: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      this.prisma.manuscriptFile.findMany({
        where: { projectId, deleted: true },
        select: {
          id: true,
          name: true,
          sizeBytes: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
    ]);

    const files = [
      ...deletedDocs.map((d) => ({
        id: d.id,
        pageId,
        title: d.path?.replace(/^\//, '') || 'document.tex',
        path: d.path,
        type: 'DOC',
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      ...deletedFiles.map((f) => ({
        id: f.id,
        pageId,
        title: f.name,
        path: `/${f.name}`,
        type: 'FILE',
        size: Number(f.sizeBytes || 0),
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    ];

    return { files };
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
   * 11. DUPLICATE PAGE
   */
  public async duplicatePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    const source = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
      : await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
        });

    if (!source) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const live = this.getLiveCollaboration();
    if (live && source.projectId) {
      await live.flushDocs(source.projectId, [pageId]).catch(() => []);
    }

    const freshSource =
      (source.projectId
        ? await this.pageScopeRepo.findDocInProject(source.projectId, pageId)
        : await this.prisma.manuscriptDoc.findUnique({
            where: { id: pageId },
          })) || source;

    return duplicateSourcePageAndNode(
      this.prisma,
      this.docstoreService,
      this.eventEmitter,
      pageId,
      freshSource,
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
}
