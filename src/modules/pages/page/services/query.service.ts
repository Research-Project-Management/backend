/**
 * modules/pages/core/services/page/page-query.ts
 * Business: Querying & listing project pages and their associated files.
 */

import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PageDoc, PageNode } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  filterRecordsByPageScope,
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveSpaceRootDocIds,
} from '../../core/utils/page-scope';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { hydratePageDocLines } from '@/modules/pages/docstore/services/doc-occ.helper';
import type { PageDocRanges, PageLifecycleContext } from './content.service';

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

    const normalizedStatus =
      query?.status === 'draft' ||
      query?.status === 'published' ||
      query?.status === 'archived'
        ? query.status
        : undefined;
    const trimmedSearch = query?.search?.trim() || undefined;

    // Canonical path: Single Source of Truth from the 3NF `Page` aggregate root table
    if (ctx.prisma.page?.findMany) {
      const pageRows = await ctx.prisma.page.findMany({
        where: {
          spaceId: projectId,
          deletedAt: null,
          ...(normalizedStatus ? { status: normalizedStatus } : {}),
          ...(trimmedSearch
            ? { title: { contains: trimmedSearch, mode: 'insensitive' } }
            : {}),
        },
        include: {
          labels: {
            include: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      const rootDocIds = pageRows
        .map((p) => p.rootDocId || p.id)
        .filter((id): id is string => Boolean(id));
      const creatorIds = Array.from(
        new Set(
          pageRows
            .map((p) => p.createdById)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      const [rootDocs, creators] = await Promise.all([
        rootDocIds.length > 0
          ? ctx.prisma.pageDoc.findMany({
              where: {
                id: { in: rootDocIds },
                spaceId: projectId,
                deletedAt: null,
              },
            })
          : Promise.resolve([]),
        creatorIds.length > 0 && ctx.prisma.user?.findMany
          ? Promise.resolve(
              ctx.prisma.user.findMany({
                where: { id: { in: creatorIds } },
                select: {
                  id: true,
                  email: true,
                  profile: { select: { name: true } },
                },
              }),
            ).catch(() => [])
          : Promise.resolve([]),
      ]);
      const docById = new Map(rootDocs.map((d) => [d.id, d]));
      const creatorById = new Map(creators.map((u) => [u.id, u]));

      const pages = await Promise.all(
        pageRows.map(async (page) => {
          const rootDocId = page.rootDocId || page.id;
          const doc = docById.get(rootDocId) ?? null;
          const docLines = doc
            ? await hydratePageDocLines(ctx.docstoreService, {
                id: doc.id,
                spaceId: getRecordSpaceId(doc) || projectId,
                lines: doc.lines,
                inStorage: doc.inStorage,
              })
            : [];
          const ranges = (
            doc?.ranges && typeof doc.ranges === 'object' ? doc.ranges : {}
          ) as PageDocRanges;
          const normalizedLabels =
            page.labels.length > 0
              ? page.labels.map((a) => ({
                  id: a.label.id,
                  name: a.label.name,
                  color: a.label.color || '#3b82f6',
                }))
              : Array.isArray(ranges.labels)
                ? ranges.labels
                : [];
          const creator = page.createdById
            ? creatorById.get(page.createdById)
            : undefined;
          const authorName =
            creator?.profile?.name || creator?.email?.split('@')[0] || 'Author';

          return {
            id: page.id,
            title: page.title || 'Untitled',
            description: page.description ?? '',
            content: docLines.join('\n'),
            status: page.status,
            thumbnail: page.thumbnail ?? undefined,
            pdfThumbnail: page.thumbnail ?? undefined,
            projectId,
            spaceId: projectId,
            author: {
              id: creator?.id ?? page.createdById ?? undefined,
              name: authorName,
            },
            labels: normalizedLabels,
            mainFile: { id: rootDocId, title: page.title || 'main.tex' },
            mainFileId: rootDocId,
            rootPageId: page.id,
            version: doc?.version ?? 1,
            rev: doc?.rev ?? 1,
            createdAt: page.createdAt.toISOString(),
            updatedAt: page.updatedAt.toISOString(),
          };
        }),
      );

      return {
        pages,
        total: pages.length,
        isEmpty: pages.length === 0,
      };
    }

    // Fallback for lightweight mocks without prisma.page delegate
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

export async function resolvePageFilesList(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  pageId: string,
  targetProjectId?: string,
  options?: { includeContent?: boolean },
) {
  let projectId: string | null = targetProjectId ?? null;
  let rootDoc: PageDoc | null = null;

  let record = await prisma.pageDoc.findUnique({
    where: { id: pageId },
  });

  if (!record) {
    const pageRow = await Promise.resolve(
      prisma.page?.findUnique?.({
        where: { id: pageId },
        select: { id: true, spaceId: true, rootDocId: true, deletedAt: true },
      }),
    ).catch(() => null);
    if (pageRow && !isRecordDeleted(pageRow)) {
      const pageSpaceId = getRecordSpaceId(pageRow);
      if (targetProjectId && pageSpaceId !== targetProjectId) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }
      if (!targetProjectId) {
        projectId = pageSpaceId;
      }
      if (pageRow.rootDocId) {
        record = await prisma.pageDoc.findUnique({
          where: { id: pageRow.rootDocId },
        });
      }
    }
  }

  if (!record) {
    const node = await prisma.pageNode.findUnique({
      where: { id: pageId },
      include: { doc: true },
    });
    const nodeSpaceId = getRecordSpaceId(node);
    if (node?.doc) {
      record = node.doc;
      if (!targetProjectId) {
        projectId = nodeSpaceId;
      }
      rootDoc = node.doc;
    } else if (node) {
      if (targetProjectId && nodeSpaceId !== targetProjectId) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }
      projectId = nodeSpaceId;
    }
  }

  if (record) {
    const recordSpaceId = getRecordSpaceId(record);
    if (targetProjectId && recordSpaceId !== targetProjectId) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${pageId} not found`,
      });
    }
    projectId = recordSpaceId;
    rootDoc = record;
  } else if (!projectId) {
    const space = prisma.space?.findUnique
      ? await Promise.resolve(
          prisma.space.findUnique({ where: { id: pageId } }),
        ).catch(() => null)
      : null;
    if (space) {
      projectId = space.id;
    } else {
      const project = await prisma.project.findUnique({
        where: { id: pageId },
      });
      if (project) {
        projectId = project.id;
      }
    }
  } else if (targetProjectId && pageId !== targetProjectId) {
    // Neither record nor node matched pageId, and pageId is not the project itself
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Document ${pageId} not found`,
    });
  }

  if (!projectId) {
    return { files: [] };
  }

  const shouldHydrate = Boolean(options?.includeContent);
  const canonicalPageId =
    (record as { pageId?: string | null } | null)?.pageId ||
    (rootDoc as { pageId?: string | null } | null)?.pageId ||
    (pageId !== projectId ? pageId : undefined);

  const [rawNodes, rawAllDocs, rootDocIds] = await Promise.all([
    prisma.pageNode.findMany({
      where: { spaceId: projectId },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.pageDoc.findMany({
      where: { spaceId: projectId, deletedAt: null },
      select: {
        id: true,
        spaceId: true,
        pageId: true,
        lastKnownPath: true,
        inStorage: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
        ...(shouldHydrate ? { lines: true } : {}),
      },
      orderBy: { createdAt: 'asc' },
    }),
    resolveSpaceRootDocIds(prisma, projectId, canonicalPageId),
  ]);

  const nodes = filterRecordsByPageScope(rawNodes, canonicalPageId, projectId);
  const allDocs = filterRecordsByPageScope(
    rawAllDocs,
    canonicalPageId,
    projectId,
  );

  const docMap = new Map(allDocs.map((d) => [d.id, d]));
  const filteredNodes = nodes.filter((node) => {
    if (node.type !== 'DOC') return false;
    if (node.docId && !docMap.has(node.docId)) return false;
    return true;
  });

  const files = await Promise.all(
    filteredNodes.map(async (node) => {
      const cleanName = node.path.replace(/^\//, '') || node.name || 'main.tex';
      const targetDoc = node.docId ? docMap.get(node.docId) : null;
      const isRootDoc = Boolean(node.docId && rootDocIds.has(node.docId));
      let content = '';
      if (shouldHydrate && targetDoc) {
        const docLines = await hydratePageDocLines(docstoreService, {
          id: targetDoc.id,
          spaceId: getRecordSpaceId(targetDoc) || projectId,
          lines:
            'lines' in targetDoc && Array.isArray(targetDoc.lines)
              ? targetDoc.lines
              : [],
          inStorage: targetDoc.inStorage,
        });
        content = docLines.join('\n');
      }
      return {
        id: node.docId || node.id,
        nodeId: node.id,
        name: cleanName,
        title: cleanName,
        path: node.path,
        isRootDoc,
        content,
        type: 'file',
        size: targetDoc?.sizeBytes ?? 0,
        pageId,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
      };
    }),
  );

  if (files.length === 0 && rootDoc && !isRecordDeleted(rootDoc)) {
    const rootDocPath =
      rootDoc.lastKnownPath ||
      (rootDoc as { path?: string }).path ||
      'main.tex';
    const cleanName = rootDocPath.replace(/^\//, '') || 'main.tex';
    let content = '';
    if (shouldHydrate) {
      const rootLines = await hydratePageDocLines(docstoreService, rootDoc);
      content = rootLines.join('\n');
    }
    files.push({
      id: rootDoc.id,
      nodeId: rootDoc.id,
      name: cleanName,
      title: cleanName,
      path: rootDocPath,
      isRootDoc: true,
      content,
      type: 'file',
      size: rootDoc.sizeBytes || 0,
      pageId,
      createdAt: rootDoc.createdAt.toISOString(),
      updatedAt: rootDoc.updatedAt.toISOString(),
    });
  }

  return { files };
}

export async function formatRootNodesAsProjectPages(
  docstoreService: DocstoreService,
  projectId: string,
  authorName: string,
  rootNodes: Array<PageNode & { doc: PageDoc | null }>,
  search?: string,
) {
  let pages = await Promise.all(
    rootNodes.map(async (node) => {
      const d = node.doc;
      const ranges = (
        d?.ranges && typeof d.ranges === 'object' ? d.ranges : {}
      ) as PageDocRanges;
      const docFallbackPath =
        d?.lastKnownPath ?? (d as { path?: string } | null)?.path;
      const title =
        (ranges as Record<string, unknown>)?.title &&
        typeof (ranges as Record<string, unknown>).title === 'string'
          ? ((ranges as Record<string, unknown>).title as string)
          : node.name || docFallbackPath?.replace(/^\//, '') || 'Untitled';
      const docLines = d
        ? await hydratePageDocLines(docstoreService, {
            id: d.id,
            spaceId: getRecordSpaceId(d) || projectId,
            lines: d.lines,
            inStorage: d.inStorage,
          })
        : [];
      const content = docLines.join('\n');
      const pageLabels = Array.isArray(ranges.labels) ? ranges.labels : [];
      const pageStatus = ranges.status || 'published';
      const pageDescription = ranges.description || '';

      return {
        id: d?.id || node.docId || node.id,
        title,
        description: pageDescription,
        content,
        status: pageStatus,
        projectId,
        author: { name: authorName },
        labels: pageLabels,
        mainFile: { id: d?.id || node.docId || node.id, title },
        mainFileId: d?.id || node.docId || node.id,
        rootPageId: d?.id || node.docId || node.id,
        version: d?.version ?? 1,
        rev: d?.rev ?? 1,
        createdAt: d?.createdAt?.toISOString() ?? node.createdAt.toISOString(),
        updatedAt: d?.updatedAt?.toISOString() ?? node.updatedAt.toISOString(),
      };
    }),
  );

  if (search && search.trim()) {
    const query = search.trim().toLowerCase();
    pages = pages.filter((p) => p.title.toLowerCase().includes(query));
  }

  return pages;
}
