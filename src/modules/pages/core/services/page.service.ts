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
  ConflictException,
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
import {
  ensureCanonicalPageId,
  resolveSpaceRootDocIds,
} from '../page-scope.helper';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { LineArray } from '@/modules/pages/docstore/domain/line-array';
import {
  DocTooLargeError,
  NullByteDetectedError,
} from '@/modules/pages/docstore/domain/doc.errors';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import {
  BootstrapService,
  CreateProjectPageParams,
} from '@/modules/pages/docstore/services/bootstrap.service';
import {
  PageDocRanges,
  resolveActiveProjectId,
  resolveCanonicalManuscriptPageId,
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
    this.pageScopeRepo = pageScopeRepo || new ScopeRepository(prisma);
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
      const rootDocIds = await resolveSpaceRootDocIds(this.prisma, projectId);
      const rootDocIdList = Array.from(rootDocIds);
      const [rootNodes, space, project] = await Promise.all([
        rootDocIdList.length > 0
          ? this.prisma.pageNode.findMany({
              where: {
                spaceId: projectId,
                type: 'DOC',
                docId: { in: rootDocIdList },
                doc: { deletedAt: null },
              },
              include: { doc: true },
              orderBy: { sortOrder: 'asc' },
            })
          : Promise.resolve([]),
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
    docId: string,
    body: UpdatePageContentParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(docId)) {
      throw new BadRequestException('A valid UUID is required for docId');
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);
    let record = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, docId)
      : await this.prisma.pageDoc.findUnique({
          where: { id: docId },
        });

    if (!record || this.isRecordDeleted(record)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${docId} not found`,
      });
    }

    const initialSpaceId = this.getRecordSpaceId(record);
    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';
    if (initialSpaceId) {
      const live = this.getLiveCollaboration();
      if (live) {
        const flushed = await live
          .flushDocs(initialSpaceId, [docId])
          .catch(() => []);
        if (Array.isArray(flushed) && flushed.length > 0) {
          const refreshed = targetProjectId
            ? await this.pageScopeRepo.findDocInProject(targetProjectId, docId)
            : await this.prisma.pageDoc.findUnique({ where: { id: docId } });
          if (refreshed && !this.isRecordDeleted(refreshed)) {
            record = refreshed;
          }
        }
      }
    }

    const recordProjectId = this.getRecordSpaceId(record);

    await assertExpectedVersionAndRev(
      this.docstoreService,
      record,
      body.expectedRev,
      body.expectedVersion,
    );

    let lines: string[];
    if (hasNewContent) {
      try {
        lines = body.lines
          ? body.lines
          : typeof body.content === 'string'
            ? LineArray.textToLines(body.content)
            : [];
      } catch (err) {
        if (
          err instanceof NullByteDetectedError ||
          err instanceof DocTooLargeError
        ) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    } else {
      lines = await this.getHydratedDocLines(record);
    }

    const result = await executeDocstoreUpdateWithOcc(
      this.docstoreService,
      record,
      lines,
      body.version,
      body.expectedRev,
    );

    const { cleanTitle, existingRanges } =
      await applyPageMetadataAndTitleUpdates(
        this.prisma,
        docId,
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
            docId,
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
        docId,
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

    const [existingPage, parentDoc] = await Promise.all([
      this.prisma.page?.findUnique
        ? Promise.resolve(
            this.prisma.page.findUnique({
              where: { id: parentDocId },
              select: { id: true, spaceId: true },
            }),
          ).catch(() => null)
        : Promise.resolve(null),
      this.prisma.pageDoc
        .findFirst({
          where: { id: parentDocId, spaceId: projectId },
          select: { pageId: true },
        })
        .catch(() => null),
    ]);
    const persistedPageId =
      (existingPage && existingPage.spaceId === projectId
        ? existingPage.id
        : undefined) ||
      (parentDoc as { pageId?: string | null } | null)?.pageId ||
      (await ensureCanonicalPageId(this.prisma, projectId, parentDocId));

    const parsed = NodePathVo.parse(fileName, 'untitled.tex');

    let createdDocResult: Awaited<
      ReturnType<typeof this.docstoreService.createDoc>
    >;
    let createdNodeResult: { id: string };

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const txPageId = await ensureCanonicalPageId(
          tx,
          projectId,
          persistedPageId,
        );
        const parentId = await ensurePrismaFolderChain(
          tx,
          projectId,
          parsed.folderChain,
          txPageId,
        );

        const doc = await this.docstoreService.createDoc(projectId, {
          path: parsed.relativePath,
          text: content,
          version: 1,
          pageId: txPageId,
          tx,
        });

        const node = await tx.pageNode.create({
          data: {
            spaceId: projectId,
            pageId: txPageId,
            parentId,
            name: parsed.leafName,
            path: parsed.normalizedPath,
            depth: parsed.depth,
            type: 'DOC',
            docId: doc._id,
          },
        });

        return { doc, node };
      });

      createdDocResult = txResult.doc;
      createdNodeResult = txResult.node;
    } catch (createErr: unknown) {
      if (isPrismaUniqueConstraintError(createErr)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'DUPLICATE_NODE_PATH',
          message: `File path already exists: ${parsed.normalizedPath}`,
        });
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
        const pageRow = this.prisma.page?.findUnique
          ? await Promise.resolve(
              this.prisma.page.findUnique({
                where: { id: pageId },
                select: {
                  id: true,
                  spaceId: true,
                  rootDocId: true,
                  deletedAt: true,
                },
              }),
            ).catch(() => null)
          : null;
        const doc = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
          : await this.prisma.pageDoc.findUnique({
              where: { id: pageId },
            });

        // Case 1: Deleting a Page Aggregate Root (even if rootDocId changed or original doc was already removed)
        if (
          pageRow &&
          (!targetProjectId ||
            !pageRow.spaceId ||
            pageRow.spaceId === targetProjectId)
        ) {
          const aggregateSpaceId = pageRow.spaceId || targetProjectId || '';
          const [activeDocs, activeFiles] = await Promise.all([
            this.prisma.pageDoc?.findMany
              ? Promise.resolve(
                  this.prisma.pageDoc.findMany({
                    where: {
                      pageId: pageRow.id,
                      ...(aggregateSpaceId
                        ? { spaceId: aggregateSpaceId }
                        : {}),
                      deletedAt: null,
                    },
                    select: { id: true },
                  }),
                ).catch(() => [])
              : Promise.resolve([]),
            this.prisma.pageFile?.findMany
              ? Promise.resolve(
                  this.prisma.pageFile.findMany({
                    where: {
                      pageId: pageRow.id,
                      ...(aggregateSpaceId
                        ? { spaceId: aggregateSpaceId }
                        : {}),
                      deletedAt: null,
                    },
                    select: {
                      id: true,
                      sizeBytes: true,
                      blobId: true,
                      hash: true,
                    },
                  }),
                ).catch(() => [])
              : Promise.resolve([]),
          ]);
          const deletedDocIds = (activeDocs || []).map((d) => d.id);
          const deletedFileIds = (activeFiles || []).map((f) => f.id);

          const deletedAt = new Date();
          await Promise.all([
            this.prisma.page.updateMany({
              where: {
                id: pageRow.id,
                ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
              },
              data: { deletedAt },
            }),
            this.prisma.pageNode
              .deleteMany({
                where: {
                  pageId: pageRow.id,
                  ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                },
              })
              .catch(() => null),
            this.prisma.pageDoc
              .updateMany({
                where: {
                  pageId: pageRow.id,
                  ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                  deletedAt: null,
                },
                data: { deletedAt },
              })
              .catch(() => null),
            this.prisma.pageFile
              ?.updateMany?.({
                where: {
                  pageId: pageRow.id,
                  ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                  deletedAt: null,
                },
                data: { deletedAt },
              })
              .catch(() => null),
          ]);

          if (aggregateSpaceId && deletedDocIds.length > 0) {
            await this.domainEventBus.publish({
              type: 'manuscript.nodes.deleted',
              projectId: aggregateSpaceId,
              deletedDocIds,
              deletedFileIds,
              hadRootDoc: true,
              occurredAt: Date.now(),
            });
          }

          if (aggregateSpaceId) {
            this.eventEmitter?.emit('manuscripts.page.deleted', {
              projectId: aggregateSpaceId,
              pageId: pageRow.id,
              deletedFiles: activeFiles || [],
            });
            this.eventEmitter?.emit('manuscripts.file-tree.change', {
              projectId: aggregateSpaceId,
              pageId: pageRow.id,
              change: {
                action: 'delete',
                node: { id: pageRow.id },
              },
            });
          }
          return { success: true };
        }

        // Case 2: Deleting a single PageDoc (never kills parent Page Aggregate Root if docId !== pageRow.id)
        if (doc) {
          const docProjectId = this.getRecordSpaceId(doc);
          const rootDocIds = await resolveSpaceRootDocIds(
            this.prisma,
            docProjectId,
            doc.pageId,
          );
          const deletedRootDoc = rootDocIds.has(doc.id);

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
          ]);

          if (deletedRootDoc) {
            const docPageId = doc.pageId;
            if (this.prisma.page?.updateMany) {
              await Promise.resolve(
                this.prisma.page.updateMany({
                  where: {
                    spaceId: docProjectId,
                    ...(docPageId ? { id: docPageId } : {}),
                    rootDocId: doc.id,
                  },
                  data: { rootDocId: null },
                }),
              ).catch(() => null);
            }
            const nextRootCandidate = await this.prisma.pageNode
              .findFirst({
                where: {
                  spaceId: docProjectId,
                  ...(docPageId ? { pageId: docPageId } : {}),
                  type: 'DOC',
                  name: { endsWith: '.tex' },
                },
                orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
              })
              .catch(() => null);
            if (nextRootCandidate?.docId && this.prisma.page?.updateMany) {
              await Promise.resolve(
                this.prisma.page.updateMany({
                  where: {
                    spaceId: docProjectId,
                    id: docPageId || nextRootCandidate.pageId,
                  },
                  data: { rootDocId: nextRootCandidate.docId },
                }),
              ).catch(() => null);
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

    const canonicalPageId = await resolveCanonicalManuscriptPageId(
      this.prisma,
      projectId,
      pageId,
    );

    const [deletedDocs, deletedFiles] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: {
          spaceId: projectId,
          ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
          deletedAt: { not: null },
        },
        select: {
          id: true,
          lastKnownPath: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      this.prisma.pageFile.findMany({
        where: {
          spaceId: projectId,
          ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
          deletedAt: { not: null },
        },
        select: {
          id: true,
          lastKnownPath: true,
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
        title: d.lastKnownPath?.replace(/^\//, '') || 'document.tex',
        path: d.lastKnownPath,
        type: 'DOC',
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      ...deletedFiles.map((f) => ({
        id: f.id,
        pageId,
        title: f.lastKnownPath,
        path: `/${f.lastKnownPath}`,
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
   * 11. DUPLICATE PAGE (Full Aggregate Root + Virtual Tree Deep Clone)
   */
  public async duplicatePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
    userId?: string | null,
  ) {
    if (!isUuid(pageId)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const targetProjectId = this.resolveActiveProjectId(authorizedProjectId);

    const directPageRow = this.prisma.page?.findUnique
      ? await Promise.resolve(
          this.prisma.page.findUnique({
            where: { id: pageId },
          }),
        ).catch(() => null)
      : null;

    const validDirectPage =
      directPageRow &&
      !this.isRecordDeleted(directPageRow) &&
      (!targetProjectId ||
        this.getRecordSpaceId(directPageRow) === targetProjectId)
        ? directPageRow
        : null;

    let entryDoc = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
      : await this.prisma.pageDoc.findUnique({
          where: { id: pageId },
        });

    if (
      (!entryDoc || this.isRecordDeleted(entryDoc)) &&
      validDirectPage?.rootDocId
    ) {
      entryDoc = targetProjectId
        ? await this.pageScopeRepo.findDocInProject(
            targetProjectId,
            validDirectPage.rootDocId,
          )
        : await this.prisma.pageDoc.findUnique({
            where: { id: validDirectPage.rootDocId },
          });
    }

    const validEntryDoc =
      entryDoc && !this.isRecordDeleted(entryDoc) ? entryDoc : null;

    if (!validDirectPage && !validEntryDoc) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Page ${pageId} not found`,
      });
    }

    const spaceId =
      this.getRecordSpaceId(validDirectPage) ||
      this.getRecordSpaceId(validEntryDoc) ||
      targetProjectId ||
      '';

    const sourcePageId =
      validDirectPage?.id ||
      validEntryDoc?.pageId ||
      (await ensureCanonicalPageId(this.prisma, spaceId, pageId));

    let sourcePageRow = validDirectPage;
    if (
      !sourcePageRow &&
      this.prisma.page?.findUnique &&
      isUuid(sourcePageId)
    ) {
      const lookedUpPage = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: sourcePageId },
        }),
      ).catch(() => null);
      if (
        lookedUpPage &&
        !this.isRecordDeleted(lookedUpPage) &&
        this.getRecordSpaceId(lookedUpPage) === spaceId
      ) {
        sourcePageRow = lookedUpPage;
      }
    }

    const live = this.getLiveCollaboration();
    if (live && spaceId) {
      const pageDocsToFlush = this.prisma.pageDoc?.findMany
        ? await Promise.resolve(
            this.prisma.pageDoc.findMany({
              where: { spaceId, pageId: sourcePageId, deletedAt: null },
              select: { id: true },
            }),
          ).catch(() => null)
        : null;
      const docIdsToFlush = Array.from(
        new Set([
          ...(Array.isArray(pageDocsToFlush)
            ? pageDocsToFlush.map((d) => d.id)
            : []),
          ...(validEntryDoc?.id ? [validEntryDoc.id] : [pageId]),
        ]),
      );
      await live.flushDocs(spaceId, docIdsToFlush).catch(() => []);
    }

    return duplicateSourcePageAndNode(
      this.prisma,
      this.docstoreService,
      this.eventEmitter,
      {
        spaceId,
        sourcePageId,
        sourcePageRow,
        fallbackDoc: validEntryDoc,
        actorId: userId,
      },
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
      if (
        altSourceProjectId &&
        altSourceProjectId !== resolvedSourceProjectId
      ) {
        throw new ForbiddenException(
          'Source file does not belong to specified sourceProjectId',
        );
      }
    }

    // Verify user has access to source project if userId is provided and projects differ
    if (
      userId &&
      resolvedSourceProjectId &&
      resolvedSourceProjectId !== targetProjectId &&
      resolvedSourceProjectId !== userId
    ) {
      const sourceProject = await this.prisma.project
        .findFirst({
          where: {
            id: resolvedSourceProjectId,
            OR: [{ createdById: userId }, { members: { some: { userId } } }],
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
        await live
          .flushDocs(sourceDocProjectId, [sourceDoc.id])
          .catch(() => []);
      }
      const lines = await this.getHydratedDocLines(sourceDoc);
      const content = lines.join('\n');
      const rawTargetName =
        body.targetPath ||
        body.targetName ||
        sourceDoc.node?.path ||
        sourceDoc.lastKnownPath ||
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
      body.targetPath || body.targetName || bin.lastKnownPath || 'imported.bin';
    const parsed = NodePathVo.parse(rawTargetName, 'imported.bin');

    const createdRecord = await this.prisma.$transaction(async (tx) => {
      const targetPageId = await ensureCanonicalPageId(
        tx,
        targetProjectId,
        body.parentPageId,
      );
      const parentId = await ensurePrismaFolderChain(
        tx,
        targetProjectId,
        parsed.folderChain,
        targetPageId,
      );

      const newFile = await tx.pageFile.create({
        data: {
          spaceId: targetProjectId,
          pageId: targetPageId,
          blobId: bin.blobId ?? null,
          lastKnownPath: parsed.relativePath || parsed.leafName,
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
          pageId: targetPageId,
          parentId,
          name: parsed.leafName,
          path: parsed.normalizedPath,
          depth: parsed.depth,
          type: 'FILE',
          fileId: newFile.id,
        },
      });

      if (bin.blobId) {
        if (typeof tx.$executeRaw === 'function') {
          await tx.$executeRaw`
            UPDATE storage_blobs
            SET ref_count = ref_count + 1,
                status = 'READY'::"BlobStatus",
                tombstone_at = NULL
            WHERE id = ${bin.blobId}::uuid
          `.catch(() => undefined);
        } else if (tx.storageBlob?.updateMany) {
          await tx.storageBlob
            .updateMany({
              where: { id: bin.blobId },
              data: {
                refCount: { increment: 1 },
                status: 'READY',
                tombstoneAt: null,
              },
            })
            .catch(() => undefined);
        }
      }

      const importedBytes = Number(bin.sizeBytes ?? 0);
      if (importedBytes > 0 && tx.storageQuota?.updateMany) {
        await tx.storageQuota
          .updateMany({
            where: { spaceId: targetProjectId },
            data: { usedBytes: { increment: BigInt(importedBytes) } },
          })
          .catch(() => undefined);
      }

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
