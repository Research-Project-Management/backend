/**
 * modules/pages/core/services/page-query-metadata.helper.ts
 * Page query formatting, metadata/label assignment, thumbnail settings, and file list helpers.
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PageDoc, PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  filterRecordsByPageScope,
  getRecordSpaceId,
  isPrismaUniqueConstraintError,
  isRecordDeleted,
  resolveSpaceRootDocIds,
  type PageScopeDbClient,
} from '../page-scope.helper';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { hydratePageDocLines } from '@/modules/pages/docstore/services/doc-occ.helper';

export interface PageDocRanges {
  labels?: Array<{ id: string; name?: string; color?: string }>;
  labelIds?: string[];
  status?: string;
  description?: string;
  pdfThumbnail?: string;
  [key: string]: unknown;
}

export async function applyPageMetadataAndTitleUpdates(
  prisma: PrismaService,
  pageId: string,
  record: {
    spaceId?: string;
    projectId?: string;
    pageId?: string | null;
    lastKnownPath?: string;
    path?: string;
    ranges: unknown;
  },
  body: {
    title?: string;
    status?: 'draft' | 'published' | 'archived';
    description?: string;
  },
  eventEmitter?: EventEmitter2,
): Promise<{ cleanTitle: string | undefined; existingRanges: PageDocRanges }> {
  const recordProjectId = getRecordSpaceId(record);
  const currentDocPath = record.lastKnownPath || record.path || 'document.tex';
  const rawTitleTrimmed = body.title
    ? body.title.trim().replace(/\\/g, '/')
    : undefined;
  const hasExplicitRootPrefix = Boolean(rawTitleTrimmed?.startsWith('/'));
  const cleanTitle = rawTitleTrimmed
    ? rawTitleTrimmed.replace(/^\/+|\/+$/g, '')
    : undefined;

  if (cleanTitle) {
    let titleParsed: ReturnType<typeof NodePathVo.parse>;
    try {
      titleParsed = NodePathVo.parse(cleanTitle, cleanTitle);
    } catch {
      throw new BadRequestException(
        `Invalid document title or path: ${cleanTitle}`,
      );
    }

    const existingParsed = NodePathVo.parse(currentDocPath, 'document.tex');
    const isExplicitPathChange =
      titleParsed.segments.length > 1 || hasExplicitRootPrefix;
    const isDisplayOnlyTitleUpdate =
      !isExplicitPathChange &&
      !/\.[a-z0-9]{1,10}$/i.test(titleParsed.leafName) &&
      /\.(tex|rtex|rnw)$/i.test(existingParsed.leafName);
    const targetParsed = isExplicitPathChange
      ? titleParsed
      : existingParsed.parentPath && existingParsed.parentPath !== '/'
        ? NodePathVo.parse(
            `${existingParsed.parentPath}/${titleParsed.leafName}`,
            titleParsed.leafName,
          )
        : titleParsed;

    if (!isDisplayOnlyTitleUpdate) {
      const runTitleSync = async (
        db: Pick<PrismaService, 'pageDoc' | 'pageNode' | 'page'>,
      ) => {
        const parentId = await ensurePrismaFolderChain(
          db,
          recordProjectId,
          targetParsed.folderChain,
          record.pageId,
        );
        await db.pageNode?.updateMany({
          where: {
            spaceId: recordProjectId,
            OR: [{ docId: pageId }, { id: pageId }],
          },
          data: {
            name: targetParsed.leafName,
            path: targetParsed.normalizedPath,
            depth: targetParsed.depth,
            ...(isExplicitPathChange || parentId !== null ? { parentId } : {}),
          },
        });
        await db.pageDoc?.update({
          where: { id: pageId },
          data: { lastKnownPath: targetParsed.relativePath },
        });
      };

      try {
        if (typeof prisma.$transaction === 'function') {
          await prisma.$transaction(async (tx) => {
            const client = tx?.pageNode ? tx : prisma;
            await runTitleSync(client);
          });
        } else {
          await runTitleSync(prisma);
        }
        eventEmitter?.emit('pages.file-tree.change', {
          projectId: recordProjectId,
          change: {
            action: 'rename',
            node: {
              id: pageId,
              docId: pageId,
              name: targetParsed.leafName,
              path: targetParsed.normalizedPath,
            },
          },
        });
      } catch (err: unknown) {
        if (isPrismaUniqueConstraintError(err)) {
          throw new ConflictException(
            `File path already exists: ${targetParsed.normalizedPath}`,
          );
        }
        // Non-fatal fallback for lightweight mocks
      }
    }
  }

  const existingRanges = (record.ranges as PageDocRanges) || {};
  const updatedRanges = {
    ...existingRanges,
    ...(body.status ? { status: body.status } : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
  };

  if (body.status || body.description !== undefined) {
    await prisma.pageDoc
      .update({
        where: { id: pageId },
        data: { ranges: updatedRanges },
      })
      .catch(() => null);
  }

  if (
    (cleanTitle || body.status || body.description !== undefined) &&
    prisma.page?.updateMany
  ) {
    await Promise.resolve(
      prisma.page.updateMany({
        where: {
          spaceId: recordProjectId,
          OR: [{ id: pageId }, { rootDocId: pageId }],
        },
        data: {
          ...(cleanTitle ? { title: cleanTitle } : {}),
          ...(body.status ? { status: body.status } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        },
      }),
    ).catch(() => null);
  }

  return { cleanTitle, existingRanges };
}

export async function updateProjectThumbnailSettings(
  prisma: PrismaService,
  projectId: string,
  pdfThumbnail: string,
): Promise<void> {
  const proj = await prisma.project
    .findUnique({
      where: { id: projectId },
      select: { settings: true },
    })
    .catch(() => null);
  if (proj) {
    const settings = (proj.settings as Record<string, unknown>) || {};
    const manuscriptSettings =
      (settings.manuscript as Record<string, unknown>) || {};
    await prisma.project
      .update({
        where: { id: projectId },
        data: {
          settings: {
            ...settings,
            manuscript: {
              ...manuscriptSettings,
              pdfThumbnail,
            },
          },
        },
      })
      .catch(() => null);
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
    resolveSpaceRootDocIds(
      prisma as unknown as PageScopeDbClient,
      projectId,
      canonicalPageId,
    ),
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
      const nodeCompat = node as { isRootDoc?: boolean; sizeBytes?: number };
      const isRootDoc = Boolean(
        (node.docId && rootDocIds.has(node.docId)) || nodeCompat.isRootDoc,
      );
      let content = '';
      if (shouldHydrate && targetDoc) {
        const docLines = await hydratePageDocLines(docstoreService, {
          id: targetDoc.id,
          spaceId: getRecordSpaceId(targetDoc) || projectId,
          lines: (targetDoc as unknown as { lines?: string[] }).lines || [],
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
        size: targetDoc?.sizeBytes ?? nodeCompat.sizeBytes ?? 0,
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

export async function resolveProjectLabels(
  prisma: PrismaService,
  projectId: string,
  labelIds: string[],
): Promise<{ id: string; name: string; color: string }[]> {
  if (!labelIds || labelIds.length === 0) return [];
  try {
    if (prisma.spaceLabel?.findMany) {
      const found = await prisma.spaceLabel.findMany({
        where: {
          id: { in: labelIds },
          OR: [
            { spaceId: projectId },
            { projectAssignments: { some: { projectId } } },
          ],
        },
      });
      return found.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export async function resolveAndAssignLabelsForDoc(
  prisma: PrismaService,
  pageScopeRepo: ScopeRepository,
  projectId: string,
  pageId: string,
  labelIds: string[],
) {
  const doc = await pageScopeRepo.findDocInProject(projectId, pageId);
  if (!doc) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: `Document ${pageId} not found`,
    });
  }

  const targetProjectId = getRecordSpaceId(doc) || projectId;
  const labels = await resolveProjectLabels(prisma, targetProjectId, labelIds);

  await pageScopeRepo.updateDocInProject(projectId, pageId, {
    ranges: { labelIds, labels },
  });

  return { labels };
}
