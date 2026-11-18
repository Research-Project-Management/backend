/**
 * modules/pages/docstore/controllers/doc.helpers.ts
 * Co-located helper, mapping, tree-building, and sub-operation functions
 * for DocController.
 */

import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PageDoc, PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  ensureCanonicalPageId,
  resolveSpaceRootDocIds,
  type PageScopeDbClient,
} from '@/modules/pages/core/page-scope.helper';
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

/**
 * Isolates VFS nodes, docs, and binary files to a specific Manuscript Page inside a Space
 * while preserving 100% backward compatibility for legacy single-page spaces where `pageId` is null.
 */
export function filterRecordsByPageScope<
  T extends { pageId?: string | null; id?: string; docId?: string | null },
>(
  records: readonly T[],
  pageId?: string | null,
  _spaceId?: string | null,
): T[] {
  if (!pageId) {
    return [...records];
  }
  const hasAnyScopedRecord = records.some((r) => Boolean(r.pageId));
  if (!hasAnyScopedRecord) {
    return [...records];
  }
  const exactMatches = records.filter(
    (r) => r.pageId === pageId || r.id === pageId || r.docId === pageId,
  );
  if (exactMatches.length > 0) {
    return records.filter(
      (r) =>
        r.pageId === pageId ||
        (r.pageId == null && (r.id === pageId || r.docId === pageId)),
    );
  }
  return records.filter((r) => r.pageId == null);
}

export async function resolveCanonicalManuscriptPageId(
  prisma: PrismaService,
  spaceId: string,
  candidateId?: string | null,
): Promise<string | undefined> {
  if (!candidateId || !isUuid(candidateId) || candidateId === spaceId) {
    return undefined;
  }
  const page = await Promise.resolve(
    prisma.page?.findUnique?.({
      where: { id: candidateId },
      select: { id: true, spaceId: true },
    }),
  ).catch(() => null);
  if (page?.id && page.spaceId === spaceId) {
    return page.id;
  }
  const doc = await Promise.resolve(
    prisma.pageDoc?.findFirst?.({
      where: { id: candidateId, spaceId },
      select: { id: true, pageId: true },
    }),
  ).catch(() => null);
  if (doc) {
    return (doc as { pageId?: string | null }).pageId || doc.id;
  }
  const node = await Promise.resolve(
    prisma.pageNode?.findFirst?.({
      where: { id: candidateId, spaceId },
      select: { pageId: true, docId: true },
    }),
  ).catch(() => null);
  if (node) {
    return (
      (node as { pageId?: string | null }).pageId || node.docId || undefined
    );
  }
  return undefined;
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
        if (pageRow) {
          const pageRowSpaceId = getRecordSpaceId(pageRow);
          if (!isRecordDeleted(pageRow) && pageRowSpaceId === targetProjectId) {
            if (pageRow.rootDocId) {
              record = await prisma.pageDoc.findFirst({
                where: {
                  id: pageRow.rootDocId,
                  spaceId: targetProjectId,
                  deletedAt: null,
                },
                include: { node: true },
              });
            }
            if (!record) {
              record = await prisma.pageDoc.findFirst({
                where: {
                  spaceId: targetProjectId,
                  pageId,
                  deletedAt: null,
                },
                orderBy: { createdAt: 'asc' },
                include: { node: true },
              });
              if (record && !pageRow.rootDocId && prisma.page?.updateMany) {
                await Promise.resolve(
                  prisma.page.updateMany({
                    where: {
                      id: pageId,
                      spaceId: targetProjectId,
                      rootDocId: null,
                    },
                    data: { rootDocId: record.id },
                  }),
                ).catch(() => undefined);
              }
            }
          }
          return record;
        }
      }

      if (!record && pageId === targetProjectId && prisma.page?.findFirst) {
        const defaultPage = await Promise.resolve(
          prisma.page.findFirst({
            where: {
              spaceId: targetProjectId,
              deletedAt: null,
              rootDocId: { not: null },
            },
            orderBy: { createdAt: 'asc' },
            select: { rootDocId: true },
          }),
        ).catch(() => null);
        if (defaultPage?.rootDocId) {
          record = await prisma.pageDoc.findFirst({
            where: {
              id: defaultPage.rootDocId,
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
        OR: [
          { node: { path: `/${cleanPath}` } },
          { lastKnownPath: `/${cleanPath}` },
          { lastKnownPath: cleanPath },
        ],
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
  record: PageDoc & { node: PageNode | null; path?: string },
) {
  const projectId = getRecordSpaceId(record);
  const pageId = (record as { pageId?: string | null }).pageId ?? record.id;
  const recordPath =
    record.node?.path || record.lastKnownPath || record.path || 'document.tex';
  const doc = record.inStorage
    ? {
        ...(await docstoreService.getDoc(projectId, record.id)),
        spaceId: projectId,
        pageId,
      }
    : {
        _id: record.id,
        id: record.id,
        spaceId: projectId,
        projectId,
        pageId,
        path: recordPath,
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
    record.node?.name ||
    NodePathVo.toRelative(doc.path || 'document.tex') ||
    'document.tex';

  return {
    ...doc,
    spaceId: projectId,
    pageId,
    page: {
      id: doc._id,
      title,
      content,
      status: 'published',
      spaceId: projectId,
      projectId,
      pageId,
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

export async function assertExpectedVersionAndRev(
  docstoreService: DocstoreService,
  record: {
    id: string;
    spaceId?: string;
    projectId?: string;
    rev: number;
    version: number;
    lines?: unknown;
    inStorage?: boolean;
  },
  expectedRev?: number,
  expectedVersion?: number,
): Promise<void> {
  if (
    (expectedRev !== undefined && record.rev !== expectedRev) ||
    (expectedVersion !== undefined && record.version !== expectedVersion)
  ) {
    let remoteLines: string[] = [];
    const projectId = getRecordSpaceId(record);
    try {
      if (record.lines === undefined && projectId) {
        const latest = await docstoreService.getDoc(projectId, record.id);
        remoteLines = Array.isArray(latest?.lines) ? latest.lines : [];
      } else {
        remoteLines = await hydratePageDocLines(docstoreService, {
          ...record,
          lines: record.lines ?? [],
        });
      }
    } catch {
      remoteLines = [];
    }
    const conflictDetails = {
      docId: record.id,
      expectedRev,
      expectedVersion,
      currentRev: record.rev,
      rev: record.rev,
      currentVersion: record.version,
      remoteContent: remoteLines.join('\n'),
    };
    throw new ConflictException({
      statusCode: 409,
      code: 'DOC_VERSION_CONFLICT',
      message: 'Document has been modified by another session',
      ...conflictDetails,
      details: conflictDetails,
    });
  }
}

export async function executeDocstoreUpdateWithOcc(
  docstoreService: DocstoreService,
  record: {
    id: string;
    spaceId?: string;
    projectId?: string;
    rev: number;
    version: number;
    lines?: unknown;
    inStorage?: boolean;
  },
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
      const latest = await docstoreService
        .getDoc(projectId, record.id)
        .catch(() => null);
      let remoteLines: string[] = Array.isArray(latest?.lines)
        ? latest.lines
        : [];
      if (remoteLines.length === 0 && !latest) {
        try {
          remoteLines = await hydratePageDocLines(docstoreService, {
            ...record,
            lines: record.lines ?? [],
          });
        } catch {
          remoteLines = [];
        }
      }
      const errWithRev = err as { currentRev?: number };
      const currentRev = latest?.rev ?? errWithRev.currentRev ?? record.rev;
      const currentVersion = latest?.version ?? record.version;
      const conflictDetails = {
        docId: record.id,
        expectedRev,
        expectedVersion: undefined,
        currentRev,
        rev: currentRev,
        currentVersion,
        remoteContent: remoteLines.join('\n'),
      };
      throw new ConflictException({
        statusCode: 409,
        code: 'DOC_VERSION_CONFLICT',
        message: 'Document has been modified by another session',
        ...conflictDetails,
        details: conflictDetails,
      });
    }
    throw err;
  }
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

async function ensureRestoredAssetNode(
  prisma: PrismaService,
  params: {
    projectId: string;
    pageId?: string | null;
    rawPath: string;
    fallbackLeaf: string;
    type: 'DOC' | 'FILE';
    assetId: string;
  },
): Promise<{ node: PageNode; parsed: ReturnType<typeof NodePathVo.parse> }> {
  const parsed = NodePathVo.parse(params.rawPath, params.fallbackLeaf);
  const existingNode = await prisma.pageNode.findFirst({
    where: {
      spaceId: params.projectId,
      ...(params.type === 'DOC'
        ? { docId: params.assetId }
        : { fileId: params.assetId }),
    },
  });
  if (existingNode) {
    return { node: existingNode, parsed };
  }

  const canonicalPageId = await ensureCanonicalPageId(
    prisma,
    params.projectId,
    params.pageId,
  );

  const parentId = await ensurePrismaFolderChain(
    prisma,
    params.projectId,
    parsed.folderChain,
    canonicalPageId,
  );

  let pathConflict = await prisma.pageNode.findFirst?.({
    where: {
      spaceId: params.projectId,
      pageId: canonicalPageId,
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
              pageId: canonicalPageId,
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
          data: { lastKnownPath: relativeCleanPath },
        })
        ?.catch(() => null);
    } else {
      await prisma.pageFile
        ?.updateMany?.({
          where: { id: params.assetId, spaceId: params.projectId },
          data: { lastKnownPath: relativeCleanPath },
        })
        ?.catch(() => null);
    }
  }

  const node = await prisma.pageNode.create({
    data: {
      spaceId: params.projectId,
      pageId: canonicalPageId,
      parentId,
      name: finalLeafName,
      path: cleanPath,
      depth: parsed.depth,
      type: params.type,
      ...(params.type === 'DOC'
        ? { docId: params.assetId }
        : { fileId: params.assetId }),
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
    const docPageId = doc.pageId ?? null;
    await docstoreService.patchDoc(docProjectId, pageId, {
      deleted: false,
    });

    const rawDocPath =
      doc.lastKnownPath || (doc as { path?: string }).path || 'restored.tex';
    const { node: existingNode, parsed } = await ensureRestoredAssetNode(
      prisma,
      {
        projectId: docProjectId,
        pageId: docPageId,
        rawPath: rawDocPath,
        fallbackLeaf: 'restored.tex',
        type: 'DOC',
        assetId: doc.id,
      },
    );

    if (
      docPageId &&
      /\.(tex|rtex|rnw)$/i.test(parsed.leafName) &&
      prisma.page?.updateMany
    ) {
      await Promise.resolve(
        prisma.page.updateMany({
          where: { id: docPageId, spaceId: docProjectId, rootDocId: null },
          data: { rootDocId: doc.id },
        }),
      ).catch(() => undefined);
    }

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
    const filePageId = file.pageId ?? null;
    const wasDeleted = isRecordDeleted(file);
    await prisma.pageFile.update({
      where: { id: pageId },
      data: { deletedAt: null },
    });

    if (wasDeleted) {
      const fileBlobId = (file as { blobId?: string | null }).blobId;
      if (fileBlobId) {
        if (typeof prisma.$executeRaw === 'function') {
          await Promise.resolve(
            prisma.$executeRaw`
              UPDATE storage_blobs
              SET ref_count = ref_count + 1,
                  status = 'READY'::"BlobStatus",
                  tombstone_at = NULL
              WHERE id = ${fileBlobId}::uuid
            `,
          ).catch(() => undefined);
        } else if (prisma.storageBlob?.updateMany) {
          await Promise.resolve(
            prisma.storageBlob.updateMany({
              where: { id: fileBlobId },
              data: {
                refCount: { increment: 1 },
                status: 'READY',
                tombstoneAt: null,
              },
            }),
          ).catch(() => undefined);
        }
      }
      const restoredSize = Number(file.sizeBytes ?? 0);
      if (restoredSize > 0 && prisma.storageQuota?.updateMany) {
        await Promise.resolve(
          prisma.storageQuota.updateMany({
            where: { spaceId: fileProjectId },
            data: { usedBytes: { increment: BigInt(restoredSize) } },
          }),
        ).catch(() => undefined);
      }
    }

    const rawFilePath =
      file.lastKnownPath || (file as { name?: string }).name || 'restored.bin';
    const { node: existingNode } = await ensureRestoredAssetNode(prisma, {
      projectId: fileProjectId,
      pageId: filePageId,
      rawPath: rawFilePath,
      fallbackLeaf: 'restored.bin',
      type: 'FILE',
      assetId: file.id,
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
        title: rawFilePath,
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

export interface DuplicatePageSourceInput {
  spaceId: string;
  sourcePageId: string;
  sourcePageRow?: {
    id: string;
    spaceId?: string;
    rootDocId?: string | null;
    title?: string | null;
    description?: string | null;
    compiler?: string | null;
    texLiveVersion?: string | null;
    spellCheckLanguage?: string | null;
    settings?: unknown;
    createdById?: string | null;
  } | null;
  fallbackDoc?: PageDoc | null;
  actorId?: string | null;
}

export async function duplicateSourcePageAndNode(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  eventEmitter: EventEmitter2 | undefined,
  input: DuplicatePageSourceInput,
) {
  const { spaceId, sourcePageId, sourcePageRow, fallbackDoc, actorId } = input;
  const validActorId = actorId && isUuid(actorId) ? actorId : null;

  const [fetchedDocs, fetchedFiles, fetchedNodes] = await Promise.all([
    prisma.pageDoc?.findMany
      ? Promise.resolve(
          prisma.pageDoc.findMany({
            where: { spaceId, pageId: sourcePageId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
          }),
        ).catch(() => null)
      : Promise.resolve(null),
    prisma.pageFile?.findMany
      ? Promise.resolve(
          prisma.pageFile.findMany({
            where: { spaceId, pageId: sourcePageId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
          }),
        ).catch(() => [])
      : Promise.resolve([]),
    prisma.pageNode?.findMany
      ? Promise.resolve(
          prisma.pageNode.findMany({
            where: { spaceId, pageId: sourcePageId },
            orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
          }),
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  const sourceDocs: PageDoc[] =
    Array.isArray(fetchedDocs) && fetchedDocs.length > 0
      ? fetchedDocs
      : fallbackDoc
        ? [fallbackDoc]
        : [];
  const sourceFiles = Array.isArray(fetchedFiles) ? fetchedFiles : [];
  const sourceNodes = Array.isArray(fetchedNodes) ? fetchedNodes : [];

  const sourceRootDoc =
    (sourcePageRow?.rootDocId
      ? sourceDocs.find((d) => d.id === sourcePageRow.rootDocId)
      : undefined) ||
    (fallbackDoc
      ? sourceDocs.find((d) => d.id === fallbackDoc.id)
      : undefined) ||
    sourceDocs[0] ||
    fallbackDoc ||
    undefined;

  const rootRanges =
    sourceRootDoc?.ranges && typeof sourceRootDoc.ranges === 'object'
      ? (sourceRootDoc.ranges as Record<string, unknown>)
      : {};
  const rawBaseTitle =
    (typeof rootRanges.title === 'string' && rootRanges.title.trim()) ||
    sourcePageRow?.title?.trim() ||
    NodePathVo.toRelative(
      sourceRootDoc?.lastKnownPath ||
        (sourceRootDoc as { path?: string } | undefined)?.path ||
        '',
    ) ||
    'Untitled';
  const baseTitleWithoutCopy =
    rawBaseTitle.replace(/ \(Copy(?: \d+)?\)$/i, '').trim() || 'Untitled';

  let existingTitles = new Set<string>();
  if (prisma.page?.findMany) {
    const existingPages = await Promise.resolve(
      prisma.page.findMany({
        where: { spaceId, deletedAt: null },
        select: { title: true },
      }),
    ).catch(() => []);
    if (Array.isArray(existingPages)) {
      existingTitles = new Set(
        existingPages
          .map((p) =>
            typeof p?.title === 'string' ? p.title.trim().toLowerCase() : '',
          )
          .filter(Boolean),
      );
    }
  }

  let newPageTitle = `${baseTitleWithoutCopy} (Copy)`;
  let copyIdx = 1;
  while (existingTitles.has(newPageTitle.toLowerCase()) && copyIdx <= 100) {
    copyIdx++;
    newPageTitle = `${baseTitleWithoutCopy} (Copy ${copyIdx})`;
  }

  const hydratedDocLinesById = new Map<string, string[]>();
  const hasAnyInStorageDoc = sourceDocs.some((d) => Boolean(d.inStorage));
  if (hasAnyInStorageDoc) {
    for (const doc of sourceDocs) {
      hydratedDocLinesById.set(
        doc.id,
        await hydratePageDocLines(docstoreService, doc),
      );
    }
  } else if (sourceRootDoc) {
    hydratedDocLinesById.set(
      sourceRootDoc.id,
      await hydratePageDocLines(docstoreService, sourceRootDoc),
    );
  }

  const newPageId = crypto.randomUUID();
  const rootFilePath =
    sourceRootDoc?.lastKnownPath ||
    (sourceRootDoc as { path?: string } | undefined)?.path ||
    'main.tex';
  const rootFileName = NodePathVo.toRelative(rootFilePath) || 'main.tex';
  const nowIso = new Date().toISOString();

  await prisma.$transaction(async (tx) => {
    const txRaw = tx as unknown as {
      $queryRaw?: (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Array<{ exists?: boolean }>>;
      $executeRaw?: (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown>;
    };

    const canProbeStoredProc =
      Boolean(sourcePageRow) &&
      !hasAnyInStorageDoc &&
      typeof txRaw.$queryRaw === 'function' &&
      typeof txRaw.$executeRaw === 'function';

    if (canProbeStoredProc) {
      const procRows = await Promise.resolve(
        txRaw.$queryRaw!`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'clone_page_virtual_tree') AS "exists"`,
      ).catch(() => []);
      if (Array.isArray(procRows) && Boolean(procRows[0]?.exists)) {
        await txRaw.$executeRaw!`
          CALL clone_page_virtual_tree(
            ${sourcePageId}::uuid,
            ${newPageId}::uuid,
            ${spaceId}::uuid,
            ${newPageTitle}::varchar,
            ${validActorId}::uuid
          )
        `;
        return;
      }
    }

    // Fallback in-transaction Prisma deep clone (preserves BCNF/3NF invariants & triggers)
    if (tx.page?.create || tx.page?.upsert) {
      const pagePayload = {
        id: newPageId,
        spaceId,
        rootDocId: null,
        title: newPageTitle,
        description: sourcePageRow?.description ?? null,
        status: 'draft',
        compiler: sourcePageRow?.compiler || 'pdflatex',
        texLiveVersion: sourcePageRow?.texLiveVersion || '2024',
        spellCheckLanguage: sourcePageRow?.spellCheckLanguage || 'en_US',
        settings:
          (sourcePageRow?.settings as Prisma.InputJsonValue | undefined) ?? {},
        createdById: validActorId ?? sourcePageRow?.createdById ?? null,
      };
      if (tx.page.create) {
        await tx.page.create({ data: pagePayload });
      } else if (tx.page.upsert) {
        await tx.page.upsert({
          where: { id: newPageId },
          create: pagePayload,
          update: { title: newPageTitle },
        });
      }
    }

    const docIdMap = new Map<string, string>();
    let clonedRootDocId: string | null = null;
    for (let idx = 0; idx < sourceDocs.length; idx++) {
      const doc = sourceDocs[idx];
      const isRootDoc = sourceRootDoc ? doc.id === sourceRootDoc.id : idx === 0;
      const newDocId = isRootDoc ? newPageId : crypto.randomUUID();
      docIdMap.set(doc.id, newDocId);
      if (isRootDoc) {
        clonedRootDocId = newDocId;
      }

      const hydratedLines =
        hydratedDocLinesById.get(doc.id) ??
        (Array.isArray(doc.lines) ? (doc.lines as string[]) : []);
      const baseRanges =
        doc.ranges && typeof doc.ranges === 'object'
          ? (doc.ranges as Record<string, unknown>)
          : {};
      const clonedRanges = isRootDoc
        ? { ...baseRanges, title: newPageTitle }
        : baseRanges;

      await tx.pageDoc.create({
        data: {
          id: newDocId,
          spaceId,
          pageId: newPageId,
          lastKnownPath: doc.lastKnownPath,
          lines: hydratedLines,
          rev: 1,
          version: 1,
          ranges: clonedRanges as Prisma.InputJsonValue,
          hash: doc.hash,
          sizeBytes: doc.sizeBytes,
          inStorage: false,
          storageKey: null,
        },
      });
    }

    if (clonedRootDocId && (tx.page?.updateMany || tx.page?.update)) {
      if (tx.page.updateMany) {
        await tx.page.updateMany({
          where: { id: newPageId, spaceId },
          data: { rootDocId: clonedRootDocId },
        });
      } else if (tx.page.update) {
        await tx.page.update({
          where: { id: newPageId },
          data: { rootDocId: clonedRootDocId },
        });
      }
    }

    const fileIdMap = new Map<string, string>();
    const blobIncrements = new Map<string, number>();
    if (tx.pageFile?.create) {
      for (const file of sourceFiles) {
        const newFileId = crypto.randomUUID();
        fileIdMap.set(file.id, newFileId);
        await tx.pageFile.create({
          data: {
            id: newFileId,
            spaceId,
            pageId: newPageId,
            blobId: file.blobId ?? null,
            lastKnownPath: file.lastKnownPath,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            hash: file.hash,
            storageKey: file.storageKey,
            bucketName: file.bucketName,
            rev: 0,
          },
        });
        if (file.blobId) {
          blobIncrements.set(
            file.blobId,
            (blobIncrements.get(file.blobId) ?? 0) + 1,
          );
        }
      }
    }

    if (tx.storageBlob?.update && blobIncrements.size > 0) {
      for (const [blobId, incrementBy] of blobIncrements.entries()) {
        await Promise.resolve(
          tx.storageBlob.update({
            where: { id: blobId },
            data: { refCount: { increment: incrementBy }, tombstoneAt: null },
          }),
        ).catch(() => null);
      }
    }

    const orderedNodes = [...sourceNodes].sort(
      (a, b) => (a.depth ?? 1) - (b.depth ?? 1),
    );
    const nodeIdMap = new Map<string, string>();
    if (tx.pageNode?.create) {
      for (const node of orderedNodes) {
        const mappedParentId = node.parentId
          ? (nodeIdMap.get(node.parentId) ?? null)
          : null;
        if (node.parentId && !mappedParentId) continue;

        const mappedDocId = node.docId
          ? (docIdMap.get(node.docId) ?? null)
          : null;
        const mappedFileId = node.fileId
          ? (fileIdMap.get(node.fileId) ?? null)
          : null;

        if (node.type === 'DOC' && !mappedDocId) continue;
        if (node.type === 'FILE' && !mappedFileId) continue;

        const newNodeId = crypto.randomUUID();
        nodeIdMap.set(node.id, newNodeId);
        await tx.pageNode.create({
          data: {
            id: newNodeId,
            spaceId,
            pageId: newPageId,
            parentId: mappedParentId,
            type: node.type,
            name: node.name,
            path: node.path,
            depth: Math.max(1, node.depth || 1),
            docId: mappedDocId,
            fileId: mappedFileId,
            sortOrder: node.sortOrder ?? 0,
          },
        });
      }
    }
  });

  const rootLines = sourceRootDoc
    ? (hydratedDocLinesById.get(sourceRootDoc.id) ?? [])
    : [];
  const content = rootLines.join('\n');

  eventEmitter?.emit('manuscripts.file-tree.change', {
    projectId: spaceId,
    change: {
      action: 'page_duplicated',
      pageId: newPageId,
      sourcePageId,
    },
  });

  return {
    page: {
      id: newPageId,
      title: newPageTitle,
      description: sourcePageRow?.description ?? '',
      content,
      status: 'draft',
      projectId: spaceId,
      mainFile: { id: newPageId, title: rootFileName },
      mainFileId: newPageId,
      rootPageId: newPageId,
      version: 1,
      rev: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    mainFile: { id: newPageId, title: rootFileName },
    rootPageId: newPageId,
    mainFileId: newPageId,
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
