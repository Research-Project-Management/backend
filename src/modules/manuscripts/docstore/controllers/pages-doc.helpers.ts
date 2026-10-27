/**
 * modules/manuscripts/docstore/controllers/pages-doc.helpers.ts
 * Co-located helper, mapping, tree-building, and sub-operation functions
 * for PagesDocController.
 */

import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ManuscriptDoc, ManuscriptNode, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { DocstoreService } from '../docstore.service';
import { DocModifiedError } from '../domain';
import { ManuscriptPageScopeRepository } from '../repositories/manuscript-page-scope.repository';

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

export async function resolveProjectIdByEntityId(
  prisma: PrismaService,
  id: string,
): Promise<string | null> {
  if (!isUuid(id)) return null;
  const doc = await prisma.manuscriptDoc.findUnique({
    where: { id },
    select: { projectId: true },
  });
  if (doc?.projectId) return doc.projectId;
  const node = await prisma.manuscriptNode.findFirst({
    where: { projectId: id },
    select: { projectId: true },
  });
  return node?.projectId ?? null;
}

export async function hydratePageDocLines(
  docstoreService: DocstoreService,
  doc: {
    id: string;
    projectId: string;
    lines: unknown;
    inStorage?: boolean;
  },
): Promise<string[]> {
  if (doc.inStorage) {
    try {
      const hydrated = await docstoreService.getDoc(doc.projectId, doc.id);
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
): Promise<(ManuscriptDoc & { node: ManuscriptNode | null }) | null> {
  if (targetProjectId) {
    if (isUuid(pageId)) {
      let record = await prisma.manuscriptDoc.findFirst({
        where: {
          projectId: targetProjectId,
          deleted: false,
          OR: [{ id: pageId }, { node: { id: pageId } }],
        },
        include: { node: true },
      });

      if (!record) {
        const rootNode = await prisma.manuscriptNode.findFirst({
          where: { projectId: targetProjectId, isRootDoc: true },
        });
        if (rootNode?.docId) {
          record = await prisma.manuscriptDoc.findFirst({
            where: {
              id: rootNode.docId,
              projectId: targetProjectId,
              deleted: false,
            },
            include: { node: true },
          });
        }
      }
      return record;
    }

    const cleanPath = pageId.startsWith('/') ? pageId.slice(1) : pageId;
    return prisma.manuscriptDoc.findFirst({
      where: {
        projectId: targetProjectId,
        deleted: false,
        OR: [{ path: `/${cleanPath}` }, { path: cleanPath }],
      },
      include: { node: true },
    });
  }

  if (isUuid(pageId)) {
    return prisma.manuscriptDoc.findUnique({
      where: { id: pageId },
      include: { node: true },
    });
  }

  return null;
}

export async function formatPageByIdResponse(
  docstoreService: DocstoreService,
  record: ManuscriptDoc & { node: ManuscriptNode | null },
) {
  let doc: {
    _id: string;
    id?: string;
    projectId?: string;
    path: string;
    lines: string[];
    version: number;
    rev: number;
    ranges?: unknown;
    hash?: string | null;
    sizeBytes?: number;
    createdAt?: Date;
    updatedAt?: Date;
  };
  if (record.inStorage) {
    doc = await docstoreService.getDoc(record.projectId, record.id);
  } else {
    const rawLines = record.lines;
    const lines = Array.isArray(rawLines)
      ? (rawLines as string[])
      : typeof rawLines === 'string'
        ? rawLines.split('\n')
        : [];
    doc = {
      _id: record.id,
      id: record.id,
      projectId: record.projectId,
      path: record.path,
      lines,
      version: record.version,
      rev: record.rev,
      ranges: record.ranges || {},
      hash: record.hash,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  const lines = doc.lines || [];
  const content = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const title =
    record.node?.name || doc.path?.replace(/^\//, '') || 'document.tex';

  return {
    ...doc,
    page: {
      id: doc._id,
      title,
      content,
      status: 'published',
      projectId: record.projectId,
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
  record: { id: string; projectId: string; rev: number; version: number },
  lines: string[],
  version?: number,
  expectedRev?: number,
) {
  try {
    return await docstoreService.updateDoc(record.projectId, record.id, {
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
  record: { projectId: string; path: string; ranges: unknown },
  body: {
    title?: string;
    status?: 'draft' | 'published' | 'archived';
    description?: string;
  },
): Promise<{ cleanTitle: string | undefined; existingRanges: PageDocRanges }> {
  const cleanTitle = body.title
    ? body.title.trim().replace(/^\//, '')
    : undefined;

  if (cleanTitle) {
    const dir = path.posix.dirname(record.path);
    const newPath =
      dir && dir !== '.' && dir !== '/'
        ? `${dir}/${cleanTitle}`
        : `/${cleanTitle}`;
    await Promise.all([
      prisma.manuscriptDoc
        .update({
          where: { id: pageId },
          data: { path: newPath },
        })
        .catch(() => null),
      prisma.manuscriptNode
        .updateMany({
          where: {
            projectId: record.projectId,
            OR: [{ docId: pageId }, { id: pageId }],
          },
          data: {
            name: cleanTitle,
            path: newPath,
          },
        })
        .catch(() => null),
    ]);
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
    await prisma.manuscriptDoc
      .update({
        where: { id: pageId },
        data: { ranges: updatedRanges },
      })
      .catch(() => null);
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
) {
  let projectId: string | null = targetProjectId ?? null;
  let rootDoc: ManuscriptDoc | null = null;

  let record = await prisma.manuscriptDoc.findUnique({
    where: { id: pageId },
  });

  if (!record) {
    const node = await prisma.manuscriptNode.findUnique({
      where: { id: pageId },
      include: { doc: true },
    });
    if (node?.doc) {
      record = node.doc;
      if (!targetProjectId) {
        projectId = node.projectId;
      }
      rootDoc = node.doc;
    } else if (node) {
      if (targetProjectId && node.projectId !== targetProjectId) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${pageId} not found`,
        });
      }
      projectId = node.projectId;
    }
  }

  if (record) {
    if (targetProjectId && record.projectId !== targetProjectId) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${pageId} not found`,
      });
    }
    projectId = record.projectId;
    rootDoc = record;
  } else if (!projectId) {
    const project = await prisma.project.findUnique({
      where: { id: pageId },
    });
    if (project) {
      projectId = project.id;
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

  const [nodes, allDocs] = await Promise.all([
    prisma.manuscriptNode.findMany({
      where: { projectId },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.manuscriptDoc.findMany({
      where: { projectId, deleted: false },
      select: {
        id: true,
        projectId: true,
        path: true,
        lines: true,
        inStorage: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const docMap = new Map(allDocs.map((d) => [d.id, d]));
  const filteredNodes = nodes.filter((node) => {
    if (node.type === 'FOLDER') return false;
    if (node.docId && !docMap.has(node.docId)) return false;
    return true;
  });

  const files = await Promise.all(
    filteredNodes.map(async (node) => {
      const cleanName = node.path.replace(/^\//, '') || node.name || 'main.tex';
      const targetDoc = node.docId ? docMap.get(node.docId) : null;
      const docLines = targetDoc
        ? await hydratePageDocLines(docstoreService, {
            id: targetDoc.id,
            projectId: targetDoc.projectId || projectId,
            lines: targetDoc.lines,
            inStorage: targetDoc.inStorage,
          })
        : [];
      const content = docLines.join('\n');
      return {
        id: node.docId || node.id,
        nodeId: node.id,
        name: cleanName,
        title: cleanName,
        path: node.path,
        content,
        type: 'file',
        size: node.sizeBytes || (targetDoc?.sizeBytes ?? 0),
        pageId,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
      };
    }),
  );

  if (files.length === 0 && rootDoc && !rootDoc.deleted) {
    const cleanName = rootDoc.path.replace(/^\//, '') || 'main.tex';
    const rootLines = await hydratePageDocLines(docstoreService, rootDoc);
    const content = rootLines.join('\n');
    files.push({
      id: rootDoc.id,
      nodeId: rootDoc.id,
      name: cleanName,
      title: cleanName,
      path: rootDoc.path,
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
  rootNodes: Array<ManuscriptNode & { doc: ManuscriptDoc | null }>,
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
            projectId: d.projectId || projectId,
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

export async function restoreDeletedDocOrFile(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  eventEmitter: EventEmitter2 | undefined,
  pageId: string,
  targetProjectId?: string,
) {
  const doc = targetProjectId
    ? await prisma.manuscriptDoc.findFirst({
        where: { id: pageId, projectId: targetProjectId },
      })
    : await prisma.manuscriptDoc.findUnique({
        where: { id: pageId },
      });

  if (doc) {
    await docstoreService.patchDoc(doc.projectId, pageId, {
      deleted: false,
    });

    const cleanPath = doc.path.startsWith('/') ? doc.path : `/${doc.path}`;
    const cleanName = doc.path.replace(/^\//, '') || 'restored.tex';
    let existingNode = await prisma.manuscriptNode.findFirst({
      where: { projectId: doc.projectId, docId: doc.id },
    });

    if (!existingNode) {
      existingNode = await prisma.manuscriptNode.create({
        data: {
          projectId: doc.projectId,
          name: cleanName,
          path: cleanPath,
          type: 'DOC',
          docId: doc.id,
          sizeBytes: doc.sizeBytes || 0,
        },
      });
    }

    eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: doc.projectId,
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
        title: cleanName,
        content,
        projectId: doc.projectId,
      },
    };
  }

  const file = targetProjectId
    ? await prisma.manuscriptFile.findFirst({
        where: { id: pageId, projectId: targetProjectId },
      })
    : await prisma.manuscriptFile.findUnique({
        where: { id: pageId },
      });

  if (file) {
    await prisma.manuscriptFile.update({
      where: { id: pageId },
      data: { deleted: false },
    });

    let existingNode = await prisma.manuscriptNode.findFirst({
      where: { projectId: file.projectId, fileId: file.id },
    });

    if (!existingNode) {
      existingNode = await prisma.manuscriptNode.create({
        data: {
          projectId: file.projectId,
          name: file.name,
          path: `/${file.name}`,
          type: 'FILE',
          fileId: file.id,
          sizeBytes: Number(file.sizeBytes || 0),
        },
      });
    }

    eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: file.projectId,
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
        projectId: file.projectId,
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
  source: ManuscriptDoc,
) {
  const sourceTitle = source.path || 'document.tex';
  const newTitle = sourceTitle.endsWith(' (Copy)')
    ? `${sourceTitle.replace(/ \(Copy\)$/, '')} (Copy 2)`
    : `${sourceTitle} (Copy)`;
  const normalizedNodePath = newTitle.startsWith('/')
    ? newTitle
    : `/${newTitle}`;

  const hydratedSourceLines = await hydratePageDocLines(
    docstoreService,
    source,
  );

  const newDoc = await prisma.manuscriptDoc.create({
    data: {
      projectId: source.projectId,
      path: newTitle,
      lines: hydratedSourceLines,
      rev: 1,
      version: 1,
      ranges: source.ranges ?? {},
      hash: source.hash,
      sizeBytes: source.sizeBytes,
    },
  });

  const sourceNode = await prisma.manuscriptNode.findFirst({
    where: { projectId: source.projectId, docId: pageId },
  });

  if (sourceNode) {
    await prisma.manuscriptNode.create({
      data: {
        projectId: source.projectId,
        parentId: sourceNode.parentId,
        type: sourceNode.type,
        name: newTitle.replace(/^\//, ''),
        path: normalizedNodePath,
        depth: sourceNode.depth,
        docId: newDoc.id,
        fileId: null,
        isRootDoc: sourceNode.isRootDoc,
        sizeBytes: source.sizeBytes,
        hash: source.hash,
        sortOrder: sourceNode.sortOrder + 1,
      },
    });

    eventEmitter?.emit('manuscripts.file-tree.change', {
      projectId: source.projectId,
      change: {
        action: 'create',
        node: {
          id: newDoc.id,
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
      projectId: source.projectId,
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

export async function resolveAndAssignLabelsForDoc(
  prisma: PrismaService,
  pageScopeRepo: ManuscriptPageScopeRepository,
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

  const targetProjectId = doc.projectId || projectId;
  let labels: { id: string; name: string; color: string }[] = [];
  try {
    const found = await prisma.label.findMany({
      where: {
        id: { in: labelIds },
        projects: { some: { projectId: targetProjectId } },
      },
    });
    if (found.length > 0) {
      labels = found.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      }));
    } else {
      const foundWork = await prisma.workItemLabel.findMany({
        where: { id: { in: labelIds }, projectId: targetProjectId },
      });
      labels = foundWork.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      }));
    }
  } catch {
    // Fallback
  }

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
