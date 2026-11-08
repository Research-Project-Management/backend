/**
 * modules/manuscripts/core/services/page.service.ts
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
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '../ports/live-collaboration.port';
import { ManuscriptDomainEventBus } from '../events/event-bus.service';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import {
  BootstrapService,
  CreateProjectPageParams,
} from '@/modules/pages/docstore/services/bootstrap.service';
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
} from '@/modules/pages/docstore/controllers/doc.helpers';

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

export interface ImportFromProjectParams {
  sourceProjectId?: string;
  sourceFileId: string;
  targetName?: string;
  targetPath?: string;
  parentPageId?: string;
}

export type { CreateProjectPageParams, PageDocRanges };

@Injectable()
export class PageService {
  private readonly logger = new Logger(PageService.name);
  private readonly liveCollab: LiveCollaborationPort;
  private readonly domainEventBus: ManuscriptDomainEventBus;
  private readonly pageScopeRepo: ScopeRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    private readonly projectBootstrapService: BootstrapService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional() domainEventBus?: ManuscriptDomainEventBus,
  ) {
    this.pageScopeRepo =
      pageScopeRepo || new ScopeRepository(prisma);
    this.liveCollab =
      liveCollabOrLegacyRef &&
      typeof (liveCollabOrLegacyRef as LiveCollaborationPort)
        .applyExternalText === 'function'
        ? (liveCollabOrLegacyRef as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
    this.domainEventBus =
      domainEventBus ?? new ManuscriptDomainEventBus(this.liveCollab);
  }

  public getDomainEventBus(): ManuscriptDomainEventBus {
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

  private getRecordSpaceId(
    record?: { spaceId?: string; projectId?: string } | null,
  ): string {
    return record?.spaceId ?? record?.projectId ?? '';
  }

  private isRecordDeleted(
    record?: { deletedAt?: Date | null; deleted?: boolean } | null,
  ): boolean {
    return Boolean(record?.deletedAt ?? record?.deleted);
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

      if (!record || this.isRecordDeleted(record)) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }

      const recordProjectId = this.getRecordSpaceId(record);
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
          if (refreshed && !this.isRecordDeleted(refreshed)) {
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
      const [rootNodes, space, project] = await Promise.all([
        this.prisma.pageNode.findMany({
          where: {
            spaceId: projectId,
            isRootDoc: true,
            OR: [{ docId: null }, { doc: { deletedAt: null } }],
          },
          include: { doc: true },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.space?.findUnique
          ? Promise.resolve(
              this.prisma.space.findUnique({
                where: { id: projectId },
                include: {
                  project: {
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
                  },
                  ownerUser: {
                    select: {
                      id: true,
                      email: true,
                      profile: { select: { name: true } },
                    },
                  },
                },
              }),
            ).catch(() => null)
          : Promise.resolve(null),
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
        space?.project?.createdBy?.profile?.name ||
        space?.project?.createdBy?.email?.split('@')[0] ||
        space?.ownerUser?.profile?.name ||
        space?.ownerUser?.email?.split('@')[0] ||
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
      : await this.prisma.pageDoc.findUnique({
          where: { id: pageId },
        });

    if (!record || this.isRecordDeleted(record)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${pageId} not found`,
      });
    }

    assertExpectedVersionAndRev(record, body.expectedRev, body.expectedVersion);

    const recordProjectId = this.getRecordSpaceId(record);
    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';
    if (!hasNewContent && recordProjectId) {
      const live = this.getLiveCollaboration();
      if (live) {
        await live.flushDocs(recordProjectId, [pageId]).catch(() => []);
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
      await applyPageMetadataAndTitleUpdates(
        this.prisma,
        pageId,
        record,
        body,
        this.eventEmitter,
      );

    const updatedLines = result.doc.lines || [];
    const content = Array.isArray(updatedLines)
      ? updatedLines.join('\n')
      : String(updatedLines);

    if (this.eventEmitter && recordProjectId) {
      try {
        this.eventEmitter.emit('manuscripts.project.event', {
          projectId: recordProjectId,
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
    if (hasNewContent && recordProjectId) {
      await this.domainEventBus.publish({
        type: 'manuscript.document.mutated',
        projectId: recordProjectId,
        docId: pageId,
        lines: result.doc.lines || [''],
        rev: result.doc.rev,
        version: result.doc.version,
        source: 'rest-docstore',
        occurredAt: Date.now(),
      });
      liveSynced = true;
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
        projectId: recordProjectId,
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
          : await this.prisma.pageDoc.findUnique({
              where: { id: pageId },
              select: { id: true, spaceId: true, ranges: true },
            });

        let projectId = this.getRecordSpaceId(record) || null;

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
    const fileName = body?.title || body?.name || 'untitled.tex';
    const content = body?.content || '';

    const projectId =
      this.resolveActiveProjectId(authorizedProjectId) ||
      (await resolveProjectIdByEntityId(this.prisma, pageId));
    const parentDocId = pageId;

    if (!projectId) {
      throw new NotFoundException(
        `Project not found for document or page ${pageId}`,
      );
    }

    const parsed = NodePathVo.parse(fileName, 'untitled.tex');

    let createdDocResult: Awaited<ReturnType<typeof this.docstoreService.createDoc>>;
    let createdNodeResult: { id: string };

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const parentId = await ensurePrismaFolderChain(
          tx,
          projectId,
          parsed.folderChain,
        );

        const doc = await this.docstoreService.createDoc(projectId, {
          path: parsed.relativePath,
          text: content,
          version: 1,
          tx,
        });

        const node = await tx.pageNode.create({
          data: {
            spaceId: projectId,
            parentId,
            name: parsed.leafName,
            path: parsed.normalizedPath,
            depth: parsed.depth,
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
          `File path already exists: ${parsed.normalizedPath}`,
        );
      }
      throw createErr;
    }

    const createdDoc = createdDocResult;
    const nodeId = createdNodeResult.id;

    this.eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId,
      change: {
        action: 'create',
        node: {
          id: nodeId,
          docId: createdDoc._id,
          name: parsed.leafName,
          path: parsed.normalizedPath,
          type: 'DOC',
        },
      },
    });

    return {
      file: {
        id: createdDoc._id,
        nodeId,
        title: parsed.relativePath || parsed.leafName,
        name: parsed.leafName,
        path: parsed.normalizedPath,
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
          : await this.prisma.pageDoc.findUnique({
              where: { id: pageId },
            });
        if (doc) {
          const docProjectId = this.getRecordSpaceId(doc);
          const existingNodes =
            (await Promise.resolve(
              this.prisma.pageNode.findMany({
                where: {
                  spaceId: docProjectId,
                  OR: [{ docId: doc.id }, { id: pageId }],
                },
              }),
            ).catch(() => [])) || [];
          const deletedRootDoc = existingNodes.some((n) => n.isRootDoc);

          await Promise.all([
            this.docstoreService.patchDoc(docProjectId, doc.id, {
              deleted: true,
              deletedAt: new Date().toISOString(),
            }),
            this.prisma.pageNode
              .deleteMany({
                where: {
                  spaceId: docProjectId,
                  OR: [{ docId: doc.id }, { id: pageId }],
                },
              })
              .catch(() => null),
            Promise.resolve(
              this.prisma.page?.updateMany?.({
                where: {
                  spaceId: docProjectId,
                  OR: [{ id: pageId }, { rootDocId: doc.id }, { rootDocId: pageId }],
                },
                data: {
                  deletedAt: new Date(),
                },
              }),
            ).catch(() => null),
          ]);

          if (deletedRootDoc) {
            await this.prisma.pageNode
              ?.updateMany?.({
                where: { spaceId: docProjectId, isRootDoc: true },
                data: { isRootDoc: false },
              })
              ?.catch(() => null);
            const nextRootCandidate = await this.prisma.pageNode
              .findFirst({
                where: {
                  spaceId: docProjectId,
                  type: 'DOC',
                  name: { endsWith: '.tex' },
                },
                orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
              })
              .catch(() => null);
            if (nextRootCandidate) {
              await this.prisma.pageNode
                .update({
                  where: { id: nextRootCandidate.id },
                  data: { isRootDoc: true },
                })
                .catch(() => null);
            }
          }

          await this.domainEventBus.publish({
            type: 'manuscript.nodes.deleted',
            projectId: docProjectId,
            deletedDocIds: [doc.id],
            deletedFileIds: [],
            hadRootDoc: deletedRootDoc,
            occurredAt: Date.now(),
          });

          this.eventEmitter?.emit('manuscripts.file-tree.change', {
            projectId: docProjectId,
            change: {
              action: 'delete',
              node: { id: pageId, docId: doc.id },
            },
          });
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
    const projectId =
      this.resolveActiveProjectId(authorizedProjectId) ||
      (await resolveProjectIdByEntityId(this.prisma, pageId));

    if (!projectId) {
      return { files: [] };
    }

    const [deletedDocs, deletedFiles] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: { spaceId: projectId, deletedAt: { not: null } },
        select: {
          id: true,
          path: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      this.prisma.pageFile.findMany({
        where: { spaceId: projectId, deletedAt: { not: null } },
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
      : await this.prisma.pageDoc.findUnique({
          where: { id: pageId },
        });

    if (!source) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const sourceProjectId = this.getRecordSpaceId(source);
    const live = this.getLiveCollaboration();
    if (live && sourceProjectId) {
      await live.flushDocs(sourceProjectId, [pageId]).catch(() => []);
    }

    const freshSource =
      (sourceProjectId
        ? await this.pageScopeRepo.findDocInProject(sourceProjectId, pageId)
        : await this.prisma.pageDoc.findUnique({
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

  /**
   * 13. IMPORT FILE / DOC FROM ANOTHER PROJECT
   */
  public async importFileFromProject(
    targetProjectOrPageId: string,
    body: ImportFromProjectParams,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string | null,
  ) {
    const sourceFileId = (body?.sourceFileId || '').trim();
    if (!sourceFileId) {
      throw new BadRequestException('sourceFileId is required');
    }

    const targetProjectId =
      this.resolveActiveProjectId(authorizedProjectId) ||
      (await resolveProjectIdByEntityId(this.prisma, targetProjectOrPageId));

    if (!targetProjectId) {
      throw new NotFoundException(
        `Target project not found for ${targetProjectOrPageId}`,
      );
    }

    // 1. Locate source node, doc, or binary file
    let sourceDoc = isUuid(sourceFileId)
      ? await this.prisma.pageDoc.findFirst({
          where: { id: sourceFileId, deletedAt: null },
          include: { node: true },
        })
      : null;

    let sourceBinaryFile =
      !sourceDoc && isUuid(sourceFileId)
        ? await this.prisma.pageFile.findFirst({
            where: { id: sourceFileId, deletedAt: null },
          })
        : null;

    if (!sourceDoc && !sourceBinaryFile && isUuid(sourceFileId)) {
      const sourceNode = await this.prisma.pageNode.findUnique({
        where: { id: sourceFileId },
        include: { doc: true },
      });
      if (sourceNode?.doc && !this.isRecordDeleted(sourceNode.doc)) {
        sourceDoc = { ...sourceNode.doc, node: sourceNode };
      } else if (sourceNode?.fileId) {
        sourceBinaryFile = await this.prisma.pageFile.findFirst({
          where: { id: sourceNode.fileId, deletedAt: null },
        });
      }
    }

    if (!sourceDoc && !sourceBinaryFile) {
      throw new NotFoundException(`Source file ${sourceFileId} not found`);
    }

    const resolvedSourceProjectId =
      this.getRecordSpaceId(sourceDoc) ||
      this.getRecordSpaceId(sourceBinaryFile);
    if (
      body.sourceProjectId &&
      isUuid(body.sourceProjectId) &&
      resolvedSourceProjectId &&
      body.sourceProjectId !== resolvedSourceProjectId
    ) {
      const altSourceProjectId = await resolveProjectIdByEntityId(
        this.prisma,
        body.sourceProjectId,
      );
      if (altSourceProjectId && altSourceProjectId !== resolvedSourceProjectId) {
        throw new ForbiddenException(
          'Source file does not belong to specified sourceProjectId',
        );
      }
    }

    // Verify user has access to source project if userId is provided and projects differ
    if (
      userId &&
      resolvedSourceProjectId &&
      resolvedSourceProjectId !== targetProjectId
    ) {
      const sourceProject = await this.prisma.project
        .findFirst({
          where: {
            id: resolvedSourceProjectId,
            OR: [
              { createdById: userId },
              { members: { some: { userId } } },
            ],
          },
          select: { id: true },
        })
        .catch(() => ({ id: resolvedSourceProjectId }));
      if (!sourceProject) {
        throw new ForbiddenException(
          'Access denied to source project for file import',
        );
      }
    }

    if (sourceDoc) {
      const sourceDocProjectId = this.getRecordSpaceId(sourceDoc);
      const live = this.getLiveCollaboration();
      if (live && sourceDocProjectId) {
        await live.flushDocs(sourceDocProjectId, [sourceDoc.id]).catch(() => []);
      }
      const lines = await this.getHydratedDocLines(sourceDoc);
      const content = lines.join('\n');
      const rawTargetName =
        body.targetPath ||
        body.targetName ||
        sourceDoc.node?.path ||
        sourceDoc.path ||
        sourceDoc.node?.name ||
        'imported.tex';

      return await this.createPageFile(
        body.parentPageId || targetProjectId,
        {
          title: rawTargetName.replace(/^\/+/, ''),
          name: rawTargetName.replace(/^\/+/, ''),
          content,
        },
        targetProjectId,
      );
    }

    // Binary file copy via CAS reference in target project
    const bin = sourceBinaryFile!;
    const rawTargetName =
      body.targetPath || body.targetName || bin.name || 'imported.bin';
    const parsed = NodePathVo.parse(rawTargetName, 'imported.bin');

    const createdRecord = await this.prisma.$transaction(async (tx) => {
      const parentId = await ensurePrismaFolderChain(
        tx,
        targetProjectId,
        parsed.folderChain,
      );

      const newFile = await tx.pageFile.create({
        data: {
          spaceId: targetProjectId,
          name: parsed.relativePath || parsed.leafName,
          mimeType: bin.mimeType,
          sizeBytes: bin.sizeBytes,
          hash: bin.hash,
          storageKey: bin.storageKey,
          bucketName: bin.bucketName,
          rev: 0,
        },
      });

      const node = await tx.pageNode.create({
        data: {
          spaceId: targetProjectId,
          parentId,
          name: parsed.leafName,
          path: parsed.normalizedPath,
          depth: parsed.depth,
          type: 'FILE',
          fileId: newFile.id,
          sizeBytes: bin.sizeBytes,
          hash: bin.hash,
        },
      });

      return { newFile, node };
    });

    this.eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: targetProjectId,
      change: {
        action: 'create',
        node: {
          id: createdRecord.node.id,
          fileId: createdRecord.newFile.id,
          name: parsed.leafName,
          path: parsed.normalizedPath,
          type: 'FILE',
        },
      },
    });

    return {
      file: {
        id: createdRecord.newFile.id,
        nodeId: createdRecord.node.id,
        fileId: createdRecord.newFile.id,
        title: parsed.relativePath || parsed.leafName,
        name: parsed.leafName,
        path: parsed.normalizedPath,
        type: 'FILE',
        sizeBytes: bin.sizeBytes,
        mimeType: bin.mimeType,
        createdAt: createdRecord.newFile.createdAt.toISOString(),
        updatedAt: createdRecord.newFile.updatedAt.toISOString(),
      },
    };
  }
}

/** @deprecated Use PageService */
export { PageService as ManuscriptPageService };
