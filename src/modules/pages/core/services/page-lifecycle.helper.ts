/**
 * modules/pages/core/services/page-lifecycle.helper.ts
 * Project page listing, OCC content updates, soft-delete, and deep-clone helpers for PageService.
 */

import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { type IFilesPort } from '@/modules/files';
import { LiveCollaborationPort } from '../ports/live-collaboration.port';
import { PageDomainEventBus } from '../events/event-bus.service';
import {
  ensureCanonicalPageId,
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveSpaceRootDocIds,
} from '../page-scope.helper';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { LineArray } from '@/modules/pages/docstore/domain/line-array';
import {
  DocTooLargeError,
  NullByteDetectedError,
} from '@/modules/pages/docstore/domain/doc.errors';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import {
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
  hydratePageDocLines,
} from '@/modules/pages/docstore/services/doc-occ.helper';
import {
  applyPageMetadataAndTitleUpdates,
  formatRootNodesAsProjectPages,
} from './page-query-metadata.helper';
import { duplicateSourcePageAndNode } from './page-trash-clone.helper';

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

export interface PageLifecycleContext {
  readonly prisma: PrismaService;
  readonly docstoreService: DocstoreService;
  readonly pageScopeRepo: ScopeRepository;
  readonly liveCollab: LiveCollaborationPort;
  readonly domainEventBus: PageDomainEventBus;
  readonly logger: Logger;
  readonly eventEmitter?: EventEmitter2;
  readonly filesPort?: IFilesPort;
}

export async function getProjectPagesHelper(
  ctx: Pick<
    PageLifecycleContext,
    'prisma' | 'docstoreService' | 'liveCollab' | 'logger'
  >,
  projectId: string,
  query?: { status?: string; search?: string },
) {
  if (!isUuid(projectId)) {
    return { pages: [], total: 0, isEmpty: true };
  }
  try {
    if (ctx.liveCollab) {
      await ctx.liveCollab.flushDocs(projectId, []).catch(() => []);
    }
    const rootDocIds = await resolveSpaceRootDocIds(ctx.prisma, projectId);
    const rootDocIdList = Array.from(rootDocIds);
    const [rootNodes, space, project] = await Promise.all([
      rootDocIdList.length > 0
        ? ctx.prisma.pageNode.findMany({
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
      ctx.prisma.space?.findUnique
        ? Promise.resolve(
            ctx.prisma.space.findUnique({
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
      ctx.prisma.project.findUnique({
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
      ctx.docstoreService,
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
    ctx.logger.error(`Error fetching docs for project ${projectId}`, err);
    throw new InternalServerErrorException(
      'Failed to fetch project documents and pages',
    );
  }
}

export async function updatePageContentHelper(
  ctx: PageLifecycleContext,
  docId: string,
  body: UpdatePageContentParams,
  authorizedProjectId?: string | { id: string } | null,
) {
  if (!isUuid(docId)) {
    throw new BadRequestException('A valid UUID is required for docId');
  }

  const targetProjectId = resolveActiveProjectId(authorizedProjectId);
  let record = targetProjectId
    ? await ctx.pageScopeRepo.findDocInProject(targetProjectId, docId)
    : await ctx.prisma.pageDoc.findUnique({
        where: { id: docId },
      });

  if (!record || isRecordDeleted(record)) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Document ${docId} not found`,
    });
  }

  const initialSpaceId = getRecordSpaceId(record);
  const hasNewContent =
    body.lines !== undefined || typeof body.content === 'string';
  if (initialSpaceId && ctx.liveCollab) {
    const flushed = await ctx.liveCollab
      .flushDocs(initialSpaceId, [docId])
      .catch(() => []);
    if (Array.isArray(flushed) && flushed.length > 0) {
      const refreshed = targetProjectId
        ? await ctx.pageScopeRepo.findDocInProject(targetProjectId, docId)
        : await ctx.prisma.pageDoc.findUnique({ where: { id: docId } });
      if (refreshed && !isRecordDeleted(refreshed)) {
        record = refreshed;
      }
    }
  }

  const recordProjectId = getRecordSpaceId(record);

  await assertExpectedVersionAndRev(
    ctx.docstoreService,
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
    lines = await hydratePageDocLines(ctx.docstoreService, record);
  }

  const result = await executeDocstoreUpdateWithOcc(
    ctx.docstoreService,
    record,
    lines,
    body.version,
    body.expectedRev,
  );

  const { cleanTitle, existingRanges } = await applyPageMetadataAndTitleUpdates(
    ctx.prisma,
    docId,
    record,
    body,
    ctx.eventEmitter,
  );

  const updatedLines = result.doc.lines || [];
  const content = Array.isArray(updatedLines)
    ? updatedLines.join('\n')
    : String(updatedLines);

  if (ctx.eventEmitter && recordProjectId) {
    try {
      ctx.eventEmitter.emit('manuscripts.project.event', {
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
    await ctx.domainEventBus.publish({
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
    hash: result.doc.hash ?? null,
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
      hash: result.doc.hash ?? null,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function deletePageHelper(
  ctx: PageLifecycleContext,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
) {
  if (isUuid(pageId)) {
    try {
      const targetProjectId = resolveActiveProjectId(authorizedProjectId);
      const pageRow = ctx.prisma.page?.findUnique
        ? await Promise.resolve(
            ctx.prisma.page.findUnique({
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
        ? await ctx.pageScopeRepo.findDocInProject(targetProjectId, pageId)
        : await ctx.prisma.pageDoc.findUnique({
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
          ctx.prisma.pageDoc?.findMany
            ? Promise.resolve(
                ctx.prisma.pageDoc.findMany({
                  where: {
                    pageId: pageRow.id,
                    ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                    deletedAt: null,
                  },
                  select: { id: true },
                }),
              ).catch(() => [])
            : Promise.resolve([]),
          ctx.prisma.pageFile?.findMany
            ? Promise.resolve(
                ctx.prisma.pageFile.findMany({
                  where: {
                    pageId: pageRow.id,
                    ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
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
          ctx.prisma.page.updateMany({
            where: {
              id: pageRow.id,
              ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
            },
            data: { deletedAt },
          }),
          ctx.prisma.pageNode
            .deleteMany({
              where: {
                pageId: pageRow.id,
                ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
              },
            })
            .catch(() => null),
          ctx.prisma.pageDoc
            .updateMany({
              where: {
                pageId: pageRow.id,
                ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                deletedAt: null,
              },
              data: { deletedAt },
            })
            .catch(() => null),
          ctx.prisma.pageFile
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
          await ctx.domainEventBus.publish({
            type: 'manuscript.nodes.deleted',
            projectId: aggregateSpaceId,
            deletedDocIds,
            deletedFileIds,
            hadRootDoc: true,
            occurredAt: Date.now(),
          });
        }

        if (aggregateSpaceId) {
          ctx.eventEmitter?.emit('manuscripts.page.deleted', {
            projectId: aggregateSpaceId,
            pageId: pageRow.id,
            deletedFiles: activeFiles || [],
          });
          ctx.eventEmitter?.emit('manuscripts.file-tree.change', {
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
        const docProjectId = getRecordSpaceId(doc);
        const rootDocIds = await resolveSpaceRootDocIds(
          ctx.prisma,
          docProjectId,
          doc.pageId,
        );
        const deletedRootDoc = rootDocIds.has(doc.id);

        await Promise.all([
          ctx.docstoreService.patchDoc(docProjectId, doc.id, {
            deleted: true,
            deletedAt: new Date().toISOString(),
          }),
          ctx.prisma.pageNode
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
          if (ctx.prisma.page?.updateMany) {
            await Promise.resolve(
              ctx.prisma.page.updateMany({
                where: {
                  spaceId: docProjectId,
                  ...(docPageId ? { id: docPageId } : {}),
                  rootDocId: doc.id,
                },
                data: { rootDocId: null },
              }),
            ).catch(() => null);
          }
          const nextRootCandidate = await ctx.prisma.pageNode
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
          if (nextRootCandidate?.docId && ctx.prisma.page?.updateMany) {
            await Promise.resolve(
              ctx.prisma.page.updateMany({
                where: {
                  spaceId: docProjectId,
                  id: docPageId || nextRootCandidate.pageId,
                },
                data: { rootDocId: nextRootCandidate.docId },
              }),
            ).catch(() => null);
          }
        }

        await ctx.domainEventBus.publish({
          type: 'manuscript.nodes.deleted',
          projectId: docProjectId,
          deletedDocIds: [doc.id],
          deletedFileIds: [],
          hadRootDoc: deletedRootDoc,
          occurredAt: Date.now(),
        });

        ctx.eventEmitter?.emit('manuscripts.file-tree.change', {
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

export async function duplicatePageHelper(
  ctx: Pick<
    PageLifecycleContext,
    | 'prisma'
    | 'docstoreService'
    | 'pageScopeRepo'
    | 'liveCollab'
    | 'eventEmitter'
    | 'filesPort'
  >,
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

  const targetProjectId = resolveActiveProjectId(authorizedProjectId);

  const directPageRow = ctx.prisma.page?.findUnique
    ? await Promise.resolve(
        ctx.prisma.page.findUnique({
          where: { id: pageId },
        }),
      ).catch(() => null)
    : null;

  const validDirectPage =
    directPageRow &&
    !isRecordDeleted(directPageRow) &&
    (!targetProjectId || getRecordSpaceId(directPageRow) === targetProjectId)
      ? directPageRow
      : null;

  let entryDoc = targetProjectId
    ? await ctx.pageScopeRepo.findDocInProject(targetProjectId, pageId)
    : await ctx.prisma.pageDoc.findUnique({
        where: { id: pageId },
      });

  if ((!entryDoc || isRecordDeleted(entryDoc)) && validDirectPage?.rootDocId) {
    entryDoc = targetProjectId
      ? await ctx.pageScopeRepo.findDocInProject(
          targetProjectId,
          validDirectPage.rootDocId,
        )
      : await ctx.prisma.pageDoc.findUnique({
          where: { id: validDirectPage.rootDocId },
        });
  }

  const validEntryDoc =
    entryDoc && !isRecordDeleted(entryDoc) ? entryDoc : null;

  if (!validDirectPage && !validEntryDoc) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Page ${pageId} not found`,
    });
  }

  const spaceId =
    getRecordSpaceId(validDirectPage) ||
    getRecordSpaceId(validEntryDoc) ||
    targetProjectId ||
    '';

  const sourcePageId =
    validDirectPage?.id ||
    validEntryDoc?.pageId ||
    (await ensureCanonicalPageId(ctx.prisma, spaceId, pageId));

  let sourcePageRow = validDirectPage;
  if (!sourcePageRow && ctx.prisma.page?.findUnique && isUuid(sourcePageId)) {
    const lookedUpPage = await Promise.resolve(
      ctx.prisma.page.findUnique({
        where: { id: sourcePageId },
      }),
    ).catch(() => null);
    if (
      lookedUpPage &&
      !isRecordDeleted(lookedUpPage) &&
      getRecordSpaceId(lookedUpPage) === spaceId
    ) {
      sourcePageRow = lookedUpPage;
    }
  }

  if (ctx.liveCollab && spaceId) {
    const pageDocsToFlush = ctx.prisma.pageDoc?.findMany
      ? await Promise.resolve(
          ctx.prisma.pageDoc.findMany({
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
    await ctx.liveCollab.flushDocs(spaceId, docIdsToFlush).catch(() => []);
  }

  return duplicateSourcePageAndNode(
    ctx.prisma,
    ctx.docstoreService,
    ctx.eventEmitter,
    {
      spaceId,
      sourcePageId,
      sourcePageRow,
      fallbackDoc: validEntryDoc,
      actorId: userId,
    },
    ctx.filesPort,
  );
}
