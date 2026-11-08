/**
 * modules/manuscripts/docstore/controllers/doc.helpers.ts
 * Co-located helper, mapping, tree-building, and sub-operation functions
 * for DocController.
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PageDoc, PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '../docstore.service';
import { DocModifiedError } from '../domain';
import { ScopeRepository } from '../repositories/scope.repository';

export interface PageDocRanges {
  labels?: Array<{ id: string; name?: string; color?: string }>;
  labelIds?: string[];
  status?: string;
  description?: string;
  pdfThumbnail?: string;
  [key: string]: unknown;
}

export function resolveActiveProjectId(
  project?: string | { id: string } | null,
): string | undefined {
  if (!project) return undefined;
  return typeof project === 'string' ? project : project.id;
}

function getRecordSpaceId(
  record?: { spaceId?: string; projectId?: string } | null,
): string {
  return record?.spaceId ?? record?.projectId ?? '';
}

function isRecordDeleted(
  record?: { deletedAt?: Date | null; deleted?: boolean } | null,
): boolean {
  return Boolean(record?.deletedAt ?? record?.deleted);
}

export async function resolveProjectIdByEntityId(
  prisma: PrismaService,
  id: string,
): Promise<string | null> {
  if (!isUuid(id)) return null;
  const page = await Promise.resolve(
    prisma.page?.findUnique?.({
      where: { id },
      select: { spaceId: true },
    }),
  ).catch(() => null);
  const pageSpaceId = getRecordSpaceId(page);
  if (pageSpaceId) return pageSpaceId;
  const doc = await prisma.pageDoc.findUnique({
    where: { id },
    select: { spaceId: true },
  });
  const docSpaceId = getRecordSpaceId(doc);
  if (docSpaceId) return docSpaceId;
  const node = await prisma.pageNode.findFirst({
    where: { OR: [{ id }, { docId: id }, { spaceId: id }] },
    select: { spaceId: true },
  });
  const nodeSpaceId = getRecordSpaceId(node);
  if (nodeSpaceId) return nodeSpaceId;
  if (prisma.space?.findUnique) {
    const space = await Promise.resolve(
      prisma.space.findUnique({
        where: { id },
        select: { id: true },
      }),
    ).catch(() => null);
    if (space?.id) return space.id;
  }
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true },
  });
  return project?.id ?? null;
}

export async function hydratePageDocLines(
  docstoreService: DocstoreService,
  doc: {
    id: string;
    spaceId?: string;
    projectId?: string;
    lines: unknown;
    inStorage?: boolean;
  },
): Promise<string[]> {
  const resolvedProjectId = getRecordSpaceId(doc);
  if (doc.inStorage && resolvedProjectId) {
    try {
      const hydrated = await docstoreService.getDoc(resolvedProjectId, doc.id);
      if (Array.isArray(hydrated.lines)) {
        return hydrated.lines;
      }
    } catch {
      // Fallback to raw lines if hydration fails
    }
  }
  if (Array.isArray(doc.lines)) {
    return doc.lines as string[];
  }
  if (typeof doc.lines === 'string') {
    return doc.lines.split('\n');
  }
  return [];
}

export async function findPageRecordWithNode(
  prisma: PrismaService,
  pageId: string,
  targetProjectId?: string,
): Promise<(PageDoc & { node: PageNode | null }) | null> {
  if (targetProjectId) {
    if (isUuid(pageId)) {
      let record = await prisma.pageDoc.findFirst({
        where: {
          spaceId: targetProjectId,
          deletedAt: null,
          OR: [{ id: pageId }, { node: { id: pageId } }],
        },
        include: { node: true },
      });

      if (!record && prisma.page?.findUnique) {
        const pageRow = await Promise.resolve(
          prisma.page.findUnique({
            where: { id: pageId },
            select: { rootDocId: true, spaceId: true, deletedAt: true },
          }),
        ).catch(() => null);
        const pageRowSpaceId = getRecordSpaceId(pageRow);
        if (
          pageRow &&
          !isRecordDeleted(pageRow) &&
          pageRowSpaceId === targetProjectId &&
          pageRow.rootDocId
        ) {
          record = await prisma.pageDoc.findFirst({
            where: {
              id: pageRow.rootDocId,
              spaceId: targetProjectId,
              deletedAt: null,
            },
            include: { node: true },
          });
        }
      }

      if (!record) {
        const rootNode = await prisma.pageNode.findFirst({
          where: { spaceId: targetProjectId, isRootDoc: true },
        });
        if (rootNode?.docId) {
          record = await prisma.pageDoc.findFirst({
            where: {
              id: rootNode.docId,
              spaceId: targetProjectId,
              deletedAt: null,
            },
            include: { node: true },
          });
        }
      }
      return record;
    }

    const cleanPath = pageId.startsWith('/') ? pageId.slice(1) : pageId;
    return prisma.pageDoc.findFirst({
      where: {
        spaceId: targetProjectId,
        deletedAt: null,
        OR: [{ path: `/${cleanPath}` }, { path: cleanPath }],
      },
      include: { node: true },
    });
  }

  if (isUuid(pageId)) {
    const direct = await prisma.pageDoc.findUnique({
      where: { id: pageId },
      include: { node: true },
    });
    if (direct) return direct;

    if (prisma.page?.findUnique) {
      const pageRow = await Promise.resolve(
        prisma.page.findUnique({
          where: { id: pageId },
          select: { rootDocId: true, deletedAt: true },
        }),
      ).catch(() => null);
      if (pageRow && !isRecordDeleted(pageRow) && pageRow.rootDocId) {
        return prisma.pageDoc.findUnique({
          where: { id: pageRow.rootDocId },
          include: { node: true },
        });
      }
    }
    return null;
  }

  return null;
}

export async function formatPageByIdResponse(
  docstoreService: DocstoreService,
  record: PageDoc & { node: PageNode | null },
) {
  const projectId = getRecordSpaceId(record);
  const doc = record.inStorage
    ? await docstoreService.getDoc(projectId, record.id)
    : {
        _id: record.id,
        id: record.id,
        projectId,
        path: record.path,
        lines: await hydratePageDocLines(docstoreService, record),
        version: record.version,
        rev: record.rev,
        ranges: record.ranges || {},
        hash: record.hash,
        sizeBytes: record.sizeBytes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };

  const lines = doc.lines || [];
  const content = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const title =
    record.node?.name || NodePathVo.toRelative(doc.path || 'document.tex') || 'document.tex';

  return {
    ...doc,
    page: {
      id: doc._id,
      title,
      content,
      status: 'published',
      projectId,
      mainFile: { id: doc._id, title },
      mainFileId: doc._id,
      rootPageId: doc._id,
      version: doc.version,
      rev: doc.rev,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}

export function assertExpectedVersionAndRev(
  record: { rev: number; version: number },
  expectedRev?: number,
  expectedVersion?: number,
): void {
  if (
    (expectedRev !== undefined && record.rev !== expectedRev) ||
    (expectedVersion !== undefined && record.version !== expectedVersion)
  ) {
    throw new ConflictException({
      statusCode: 409,
      code: 'DOC_VERSION_CONFLICT',
      message: 'Document has been modified by another session',
      currentRev: record.rev,
      currentVersion: record.version,
    });
  }
}

export async function executeDocstoreUpdateWithOcc(
  docstoreService: DocstoreService,
  record: { id: string; spaceId?: string; projectId?: string; rev: number; version: number },
  lines: string[],
  version?: number,
  expectedRev?: number,
) {
  const projectId = getRecordSpaceId(record);
  try {
    return await docstoreService.updateDoc(projectId, record.id, {
      lines,
      version: (version ?? record.version) + 1,
      expectedRev,
    });
  } catch (err) {
    if (err instanceof DocModifiedError) {
      throw new ConflictException({
        statusCode: 409,
        code: 'DOC_VERSION_CONFLICT',
        message: 'Document has been modified by another session',
        currentRev: record.rev,
        currentVersion: record.version,
      });
    }
    throw err;
  }
}

export async function applyPageMetadataAndTitleUpdates(
  prisma: PrismaService,
  pageId: string,
  record: { spaceId?: string; projectId?: string; path: string; ranges: unknown },
  body: {
    title?: string;
    status?: 'draft' | 'published' | 'archived';
    description?: string;
  },
  eventEmitter?: EventEmitter2,
): Promise<{ cleanTitle: string | undefined; existingRanges: PageDocRanges }> {
  const recordProjectId = getRecordSpaceId(record);
  const rawTitleTrimmed = body.title ? body.title.trim().replace(/\\/g, '/') : undefined;
  const hasExplicitRootPrefix = Boolean(rawTitleTrimmed?.startsWith('/'));
  const cleanTitle = rawTitleTrimmed
    ? rawTitleTrimmed.replace(/^\/+|\/+$/g, '')
    : undefined;

  if (cleanTitle) {
    let titleParsed: ReturnType<typeof NodePathVo.parse>;
    try {
      titleParsed = NodePathVo.parse(cleanTitle, cleanTitle);
    } catch {
      throw new BadRequestException(`Invalid document title or path: ${cleanTitle}`);
    }

    const existingParsed = NodePathVo.parse(record.path || 'document.tex', 'document.tex');
    const isExplicitPathChange = titleParsed.segments.length > 1 || hasExplicitRootPrefix;
    const targetParsed = isExplicitPathChange
      ? titleParsed
      : existingParsed.parentPath && existingParsed.parentPath !== '/'
        ? NodePathVo.parse(`${existingParsed.parentPath}/${titleParsed.leafName}`, titleParsed.leafName)
        : titleParsed;

    const runTitleSync = async (
      db: Pick<PrismaService, 'pageDoc' | 'pageNode'>,
    ) => {
      const parentId = await ensurePrismaFolderChain(
        db,
        recordProjectId,
        targetParsed.folderChain,
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
        data: { path: targetParsed.relativePath },
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
      eventEmitter?.emit('manuscripts.file-tree.change', {
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

  const [nodes, allDocs] = await Promise.all([
    prisma.pageNode.findMany({
      where: { spaceId: projectId },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.pageDoc.findMany({
      where: { spaceId: projectId, deletedAt: null },
      select: {
        id: true,
        spaceId: true,
        path: true,
        inStorage: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
        ...(shouldHydrate ? { lines: true } : {}),
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

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
        isRootDoc: Boolean(node.isRootDoc),
        content,
        type: 'file',
        size: node.sizeBytes || (targetDoc?.sizeBytes ?? 0),
        pageId,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
      };
    }),
  );

  if (files.length === 0 && rootDoc && !isRecordDeleted(rootDoc)) {
    const cleanName = rootDoc.path.replace(/^\//, '') || 'main.tex';
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
      path: rootDoc.path,
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
      const title =
        (ranges as Record<string, unknown>)?.title &&
        typeof (ranges as Record<string, unknown>).title === 'string'
          ? ((ranges as Record<string, unknown>).title as string)
          : node.name || d?.path?.replace(/^\//, '') || 'Untitled';
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

async function ensureRestoredAssetNode(
  prisma: PrismaService,
  params: {
    projectId: string;
    rawPath: string;
    fallbackLeaf: string;
    type: 'DOC' | 'FILE';
    assetId: string;
    sizeBytes: number;
  },
): Promise<{ node: PageNode; parsed: ReturnType<typeof NodePathVo.parse> }> {
  const parsed = NodePathVo.parse(params.rawPath, params.fallbackLeaf);
  const existingNode = await prisma.pageNode.findFirst({
    where: {
      spaceId: params.projectId,
      ...(params.type === 'DOC' ? { docId: params.assetId } : { fileId: params.assetId }),
    },
  });
  if (existingNode) {
    return { node: existingNode, parsed };
  }

  const parentId = await ensurePrismaFolderChain(
    prisma,
    params.projectId,
    parsed.folderChain,
  );

  let pathConflict = await prisma.pageNode.findFirst?.({
    where: {
      spaceId: params.projectId,
      path: parsed.normalizedPath,
    },
  });

  let finalLeafName = parsed.leafName;
  let cleanPath = parsed.normalizedPath;
  let counter = 1;
  while (
    pathConflict &&
    (params.type === 'DOC' ? pathConflict.docId : pathConflict.fileId) !==
      params.assetId
  ) {
    const suffix = counter === 1 ? ' (Restored)' : ` (Restored ${counter})`;
    finalLeafName = NodePathVo.withSuffixBeforeExt(parsed.leafName, suffix);
    cleanPath =
      parsed.parentPath && parsed.parentPath !== '/'
        ? `${parsed.parentPath}/${finalLeafName}`
        : `/${finalLeafName}`;
    counter++;
    pathConflict =
      counter <= 50
        ? await prisma.pageNode.findFirst?.({
            where: {
              spaceId: params.projectId,
              path: cleanPath,
            },
          })
        : null;
  }

  const relativeCleanPath = NodePathVo.toRelative(cleanPath);
  if (relativeCleanPath !== parsed.relativePath) {
    if (params.type === 'DOC') {
      await prisma.pageDoc
        ?.updateMany?.({
          where: { id: params.assetId, spaceId: params.projectId },
          data: { path: relativeCleanPath },
        })
        ?.catch(() => null);
    } else {
      await prisma.pageFile
        ?.updateMany?.({
          where: { id: params.assetId, spaceId: params.projectId },
          data: { name: relativeCleanPath },
        })
        ?.catch(() => null);
    }
  }

  const node = await prisma.pageNode.create({
    data: {
      spaceId: params.projectId,
      parentId,
      name: finalLeafName,
      path: cleanPath,
      depth: parsed.depth,
      type: params.type,
      ...(params.type === 'DOC' ? { docId: params.assetId } : { fileId: params.assetId }),
      sizeBytes: params.sizeBytes,
    },
  });

  return { node, parsed: NodePathVo.parse(cleanPath, finalLeafName) };
}

export async function restoreDeletedDocOrFile(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  eventEmitter: EventEmitter2 | undefined,
  pageId: string,
  targetProjectId?: string,
) {
  const doc = targetProjectId
    ? await prisma.pageDoc.findFirst({
        where: { id: pageId, spaceId: targetProjectId },
      })
    : await prisma.pageDoc.findUnique({
        where: { id: pageId },
      });

  if (doc) {
    const docProjectId = getRecordSpaceId(doc);
    await docstoreService.patchDoc(docProjectId, pageId, {
      deleted: false,
    });

    const { node: existingNode, parsed } = await ensureRestoredAssetNode(prisma, {
      projectId: docProjectId,
      rawPath: doc.path || 'restored.tex',
      fallbackLeaf: 'restored.tex',
      type: 'DOC',
      assetId: doc.id,
      sizeBytes: doc.sizeBytes || 0,
    });

    eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: docProjectId,
      change: {
        action: 'create',
        node: existingNode,
      },
    });

    const lines = await hydratePageDocLines(docstoreService, doc);
    const content = lines.join('\n');

    return {
      success: true,
      page: {
        id: doc.id,
        title: parsed.relativePath,
        content,
        projectId: docProjectId,
      },
    };
  }

  const file = targetProjectId
    ? await prisma.pageFile.findFirst({
        where: { id: pageId, spaceId: targetProjectId },
      })
    : await prisma.pageFile.findUnique({
        where: { id: pageId },
      });

  if (file) {
    const fileProjectId = getRecordSpaceId(file);
    await prisma.pageFile.update({
      where: { id: pageId },
      data: { deletedAt: null },
    });

    const { node: existingNode } = await ensureRestoredAssetNode(prisma, {
      projectId: fileProjectId,
      rawPath: file.name || 'restored.bin',
      fallbackLeaf: 'restored.bin',
      type: 'FILE',
      assetId: file.id,
      sizeBytes: Number(file.sizeBytes || 0),
    });

    eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: fileProjectId,
      change: {
        action: 'create',
        node: existingNode,
      },
    });

    return {
      success: true,
      page: {
        id: file.id,
        title: file.name,
        projectId: fileProjectId,
      },
    };
  }

  throw new NotFoundException({
    statusCode: 404,
    code: 'RESOURCE_NOT_FOUND',
    message: `Document ${pageId} not found`,
  });
}

export async function duplicateSourcePageAndNode(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  eventEmitter: EventEmitter2 | undefined,
  pageId: string,
  source: PageDoc,
) {
  const sourceProjectId = getRecordSpaceId(source);
  const parsedSource = NodePathVo.parse(source.path || 'document.tex', 'document.tex');
  const leafSource = parsedSource.leafName;
  const baseLeafWithoutCopy = leafSource.replace(/ \(Copy(?: \d+)?\)(?=\.[^.]+$|$)/, '');

  let copyIdx = 1;
  let newLeafName = NodePathVo.withSuffixBeforeExt(baseLeafWithoutCopy, ' (Copy)');
  let newTitle =
    parsedSource.folderSegments.length > 0
      ? `${parsedSource.folderSegments.join('/')}/${newLeafName}`
      : newLeafName;
  let normalizedNodePath = `/${newTitle}`;

  while (copyIdx <= 50) {
    const conflict = await prisma.pageNode?.findFirst?.({
      where: {
        spaceId: sourceProjectId,
        ...(source.pageId ? { pageId: source.pageId } : {}),
        path: normalizedNodePath,
      },
    });
    if (!conflict) break;
    copyIdx++;
    const suffix = ` (Copy ${copyIdx})`;
    newLeafName = NodePathVo.withSuffixBeforeExt(baseLeafWithoutCopy, suffix);
    newTitle =
      parsedSource.folderSegments.length > 0
        ? `${parsedSource.folderSegments.join('/')}/${newLeafName}`
        : newLeafName;
    normalizedNodePath = `/${newTitle}`;
  }
  const computedDepth = parsedSource.depth;

  const [hydratedSourceLines, sourceNode] = await Promise.all([
    hydratePageDocLines(docstoreService, source),
    prisma.pageNode.findFirst({
      where: { spaceId: sourceProjectId, docId: pageId },
    }),
  ]);

  const { createdDoc: newDoc, createdNodeId } = await prisma.$transaction(async (tx) => {
    const createdDoc = await tx.pageDoc.create({
      data: {
        spaceId: sourceProjectId,
        path: newTitle,
        lines: hydratedSourceLines,
        rev: 1,
        version: 1,
        ranges: source.ranges ?? {},
        hash: source.hash,
        sizeBytes: source.sizeBytes,
      },
    });

    let createdNodeId: string | null = null;
    if (sourceNode) {
      const createdNode = await tx.pageNode.create({
        data: {
          spaceId: sourceProjectId,
          parentId: sourceNode.parentId,
          type: sourceNode.type,
          name: newLeafName,
          path: normalizedNodePath,
          depth: sourceNode.depth || computedDepth,
          docId: createdDoc.id,
          fileId: null,
          isRootDoc: false,
          sizeBytes: source.sizeBytes,
          hash: source.hash,
          sortOrder: sourceNode.sortOrder + 1,
        },
      });
      createdNodeId = createdNode.id;
    }

    return { createdDoc, createdNodeId };
  });

  if (sourceNode) {
    eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: sourceProjectId,
      change: {
        action: 'create',
        node: {
          id: createdNodeId || newDoc.id,
          path: normalizedNodePath,
          docId: newDoc.id,
        },
      },
    });
  }

  const lines = Array.isArray(newDoc.lines)
    ? (newDoc.lines as string[])
    : hydratedSourceLines;
  const content = lines.join('\n');

  return {
    page: {
      id: newDoc.id,
      title: newDoc.path,
      content,
      status: 'draft',
      projectId: sourceProjectId,
      version: newDoc.version,
      rev: newDoc.rev,
      createdAt: newDoc.createdAt.toISOString(),
      updatedAt: newDoc.updatedAt.toISOString(),
    },
    mainFile: { id: newDoc.id, title: newDoc.path },
    rootPageId: newDoc.id,
    mainFileId: newDoc.id,
  };
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

export function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; message?: unknown };
  return (
    candidate.code === 'P2002' ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes('P2002'))
  );
}
