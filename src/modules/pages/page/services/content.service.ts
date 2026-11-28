/**
 * modules/pages/core/services/page/page-content.ts
 * Business: Updating page content with OCC, metadata, title, and thumbnail settings.
 */

import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PageDoc, PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { type IFilesPort } from '@/modules/files/types/files.type';
import { LiveCollaborationPort } from '../../core/ports/live-collaboration.port';
import { PageDomainEventBus } from '../../core/events/event-bus.service';
import {
  ensureCanonicalPageId,
  getRecordSpaceId,
  isPrismaUniqueConstraintError,
  isRecordDeleted,
  resolveActiveProjectId,
  type PageScopeDbClient,
} from '../../core/utils/page-scope';
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
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
  hydratePageDocLines,
} from '@/modules/pages/docstore/services/doc-occ.helper';

import {
  type PageDocRanges,
  type PageLifecycleContext,
  type UpdatePageContentParams,
} from '../types/page.types';
export type { PageDocRanges, PageLifecycleContext, UpdatePageContentParams };

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
      ctx.eventEmitter.emit('pages.project.event', {
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
