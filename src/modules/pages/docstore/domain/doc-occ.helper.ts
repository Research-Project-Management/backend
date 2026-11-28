/**
 * modules/pages/docstore/domain/doc-occ.helper.ts
 * PageDoc hydration, lookup, response formatting, and OCC helper functions.
 */

import { ConflictException } from '@nestjs/common';
import { PageDoc, PageNode } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  NodePathVo,
  PagesDomainError,
  getRecordSpaceId,
  isRecordDeleted,
} from '@/modules/pages/core';
import type { DocstoreService } from '../docstore.service';

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
      hash: (doc as { hash?: string | null }).hash ?? record.hash ?? null,
      sizeBytes:
        (doc as { sizeBytes?: number | null }).sizeBytes ??
        record.sizeBytes ??
        undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}

function buildDocVersionConflictException(params: {
  docId: string;
  expectedRev?: number;
  expectedVersion?: number;
  currentRev: number;
  currentVersion: number;
  remoteLines: string[];
}): ConflictException {
  const conflictDetails = {
    docId: params.docId,
    expectedRev: params.expectedRev,
    expectedVersion: params.expectedVersion,
    currentRev: params.currentRev,
    rev: params.currentRev,
    currentVersion: params.currentVersion,
    remoteContent: params.remoteLines.join('\n'),
  };
  return new ConflictException({
    statusCode: 409,
    code: 'DOC_VERSION_CONFLICT',
    message: 'Document has been modified by another session',
    ...conflictDetails,
    details: conflictDetails,
  });
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
    const spaceId = getRecordSpaceId(record);
    try {
      if (record.lines === undefined && spaceId) {
        const latest = await docstoreService.getDoc(spaceId, record.id);
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
    throw buildDocVersionConflictException({
      docId: record.id,
      expectedRev,
      expectedVersion,
      currentRev: record.rev,
      currentVersion: record.version,
      remoteLines,
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
  const spaceId = getRecordSpaceId(record);
  try {
    return await docstoreService.updateDoc(spaceId, record.id, {
      lines,
      version: (version ?? record.version) + 1,
      expectedRev,
    });
  } catch (err) {
    if (err instanceof PagesDomainError && err.code === 'DOC_VERSION_CONFLICT') {
      const latest = await docstoreService
        .getDoc(spaceId, record.id)
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
      throw buildDocVersionConflictException({
        docId: record.id,
        expectedRev,
        expectedVersion: undefined,
        currentRev,
        currentVersion,
        remoteLines,
      });
    }
    throw err;
  }
}
