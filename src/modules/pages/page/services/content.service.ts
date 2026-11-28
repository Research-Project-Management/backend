/**
 * modules/pages/page/services/content.service.ts
 * Domain service updating Page content with OCC, metadata, title, and thumbnail settings.
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, PageDoc } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  NodePathVo,
  PageDomainEventBus,
  assertExpectedVersionAndRev,
  ensurePrismaFolderChain,
  executeDocstoreUpdateWithOcc,
  getRecordSpaceId,
  isPrismaUniqueConstraintError,
  isRecordDeleted,
  resolveActiveProjectId,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { LineArray } from '@/modules/pages/docstore/domain/line-array';
import {
  DocTooLargeError,
  NullByteDetectedError,
} from '@/modules/pages/docstore/domain/doc.errors';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { PageRepository } from '../page.repository';
import {
  type PageDocRanges,
  type UpdatePageContentParams,
  type UpdatePageMetadataParams,
} from '../types/page.types';
export type {
  PageDocRanges,
  UpdatePageContentParams,
  UpdatePageMetadataParams,
};

const KNOWN_DOC_FILE_EXT_RE =
  /\.(tex|rtex|rnw|bib|bst|sty|cls|tikz|pgf|ltx|def|cfg|clo|txt|md)$/i;

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
  body: UpdatePageMetadataParams,
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

    let isPageRootDoc =
      existingParsed.leafName.toLowerCase() === 'main.tex' ||
      Boolean(record.pageId && record.pageId === pageId);
    if (!isPageRootDoc && prisma.page?.findFirst) {
      const owningRootPage = await Promise.resolve(
        prisma.page.findFirst({
          where: {
            spaceId: recordProjectId,
            deletedAt: null,
            OR: [{ id: pageId }, { rootDocId: pageId }],
          },
          select: { id: true },
        }),
      ).catch(() => null);
      if (owningRootPage) {
        isPageRootDoc = true;
      }
    }

    // Never rename a Page's root PageNode (e.g. main.tex) when updating Page.title,
    // and never treat dotted display titles like "Draft v1.2" as file extensions!
    const isDisplayOnlyTitleUpdate =
      isPageRootDoc ||
      (!isExplicitPathChange &&
        !KNOWN_DOC_FILE_EXT_RE.test(titleParsed.leafName) &&
        /\.(tex|rtex|rnw)$/i.test(existingParsed.leafName));

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

  const pageDataToUpdate: Prisma.PageUncheckedUpdateManyInput = {
    ...(cleanTitle ? { title: cleanTitle } : {}),
    ...(body.status ? { status: body.status } : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.compiler ? { compiler: body.compiler } : {}),
    ...(body.texlive ? { texlive: body.texlive } : {}),
    ...(body.spellLang ? { spellLang: body.spellLang } : {}),
    ...(body.rootDocId ? { rootDocId: body.rootDocId } : {}),
  };

  if (Object.keys(pageDataToUpdate).length > 0 && prisma.page?.updateMany) {
    const targetCanonicalPageId = record.pageId || undefined;
    await Promise.resolve(
      prisma.page.updateMany({
        where: {
          spaceId: recordProjectId,
          OR: [
            { id: pageId },
            { rootDocId: pageId },
            ...(targetCanonicalPageId ? [{ id: targetCanonicalPageId }] : []),
          ],
        },
        data: pageDataToUpdate,
      }),
    ).catch(() => null);
  }

  return { cleanTitle, existingRanges };
}

@Injectable()
export class PageContentService {
  private readonly pageRepo: PageRepository;
  private readonly pageScopeRepo: ScopeRepository;
  private readonly liveCollab: LiveCollaborationPort;
  private readonly domainEventBus: PageDomainEventBus;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    @Optional() pageRepo?: PageRepository,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() domainEventBus?: PageDomainEventBus,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    this.pageRepo = pageRepo ?? new PageRepository(prisma);
    this.pageScopeRepo = pageScopeRepo ?? new ScopeRepository(prisma);
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
    this.domainEventBus =
      domainEventBus ?? new PageDomainEventBus(this.liveCollab);
  }

  /**
   * Pure Page aggregate metadata update (`title`, `description`, `status`, `compiler`, `texlive`,
   * `spellLang`, `rootDocId`) — strictly decoupled from `PageDoc` content:
   * - Never reads or unarchives `PageDoc.lines`
   * - Never flushes Yjs sessions or increments `PageDoc.version` / `PageDoc.rev`
   * - Never renames root `PageNode.name` (e.g. `main.tex`)
   */
  public async updatePageMetadata(
    pageId: string,
    body: UpdatePageMetadataParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }

    const targetSpaceId = resolveActiveProjectId(authorizedProjectId);

    let pageRow: {
      id: string;
      spaceId: string;
      title: string;
      description: string | null;
      status: string;
      compiler: string;
      texlive: string;
      spellLang: string;
      rootDocId: string | null;
      deletedAt?: Date | null;
    } | null = null;

    if (this.prisma.page?.findFirst) {
      pageRow = await Promise.resolve(
        this.prisma.page.findFirst({
          where: {
            ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
            deletedAt: null,
            OR: [{ id: pageId }, { rootDocId: pageId }],
          },
          select: {
            id: true,
            spaceId: true,
            title: true,
            description: true,
            status: true,
            compiler: true,
            texlive: true,
            spellLang: true,
            rootDocId: true,
            deletedAt: true,
          },
        }),
      ).catch(() => null);
    } else if (this.prisma.page?.findUnique) {
      const found = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: pageId },
        }),
      ).catch(() => null);
      if (
        found &&
        !isRecordDeleted(found) &&
        (!targetSpaceId || getRecordSpaceId(found) === targetSpaceId)
      ) {
        pageRow = {
          id: found.id,
          spaceId: getRecordSpaceId(found) || targetSpaceId || '',
          title: (found as { title?: string }).title || 'Untitled',
          description:
            (found as { description?: string | null }).description ?? null,
          status: (found as { status?: string }).status || 'draft',
          compiler: (found as { compiler?: string }).compiler || 'pdflatex',
          texlive: (found as { texlive?: string }).texlive || '2025',
          spellLang: (found as { spellLang?: string }).spellLang || 'en_US',
          rootDocId:
            (found as { rootDocId?: string | null }).rootDocId ?? null,
          deletedAt: (found as { deletedAt?: Date | null }).deletedAt ?? null,
        };
      }
    }

    let fallbackDoc: PageDoc | null = null;
    if (!pageRow) {
      fallbackDoc = targetSpaceId
        ? await this.pageScopeRepo.findDocInProject(targetSpaceId, pageId)
        : await this.prisma.pageDoc.findUnique({
            where: { id: pageId },
          });
      if (!fallbackDoc || isRecordDeleted(fallbackDoc)) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Page ${pageId} not found`,
        });
      }
      if (fallbackDoc.pageId && this.prisma.page?.findFirst) {
        const owningPage = await Promise.resolve(
          this.prisma.page.findFirst({
            where: {
              id: fallbackDoc.pageId,
              spaceId: getRecordSpaceId(fallbackDoc) || targetSpaceId,
              deletedAt: null,
            },
          }),
        ).catch(() => null);
        if (owningPage) {
          pageRow = {
            id: owningPage.id,
            spaceId: owningPage.spaceId,
            title: owningPage.title,
            description: owningPage.description,
            status: owningPage.status,
            compiler: owningPage.compiler,
            texlive: owningPage.texlive,
            spellLang: owningPage.spellLang,
            rootDocId: owningPage.rootDocId,
            deletedAt: owningPage.deletedAt,
          };
        }
      }
    }

    const resolvedSpaceId =
      pageRow?.spaceId || getRecordSpaceId(fallbackDoc) || targetSpaceId || '';
    const canonicalPageId = pageRow?.id || fallbackDoc?.pageId || pageId;

    if (body.rootDocId !== undefined) {
      if (!isUuid(body.rootDocId)) {
        throw new BadRequestException('A valid UUID is required for rootDocId');
      }
      if (this.prisma.pageDoc?.findFirst) {
        const candidateRootDoc = await Promise.resolve(
          this.prisma.pageDoc.findFirst({
            where: {
              id: body.rootDocId,
              spaceId: resolvedSpaceId,
              pageId: canonicalPageId,
              deletedAt: null,
            },
            select: { id: true },
          }),
        ).catch(() => null);
        if (!candidateRootDoc) {
          throw new NotFoundException({
            statusCode: 404,
            code: 'RESOURCE_NOT_FOUND',
            message: `Root document ${body.rootDocId} not found in page ${canonicalPageId}`,
          });
        }
      }
    }

    const cleanTitle =
      body.title !== undefined ? body.title.trim() || 'Untitled' : undefined;

    const updateData: Prisma.PageUncheckedUpdateManyInput = {
      ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.compiler !== undefined ? { compiler: body.compiler } : {}),
      ...(body.texlive !== undefined ? { texlive: body.texlive } : {}),
      ...(body.spellLang !== undefined ? { spellLang: body.spellLang } : {}),
      ...(body.rootDocId !== undefined ? { rootDocId: body.rootDocId } : {}),
    };

    if (Object.keys(updateData).length > 0) {
      if (this.prisma.page?.updateMany) {
        await this.prisma.page.updateMany({
          where: {
            id: canonicalPageId,
            ...(resolvedSpaceId ? { spaceId: resolvedSpaceId } : {}),
            deletedAt: null,
          },
          data: updateData,
        });
      } else if (this.prisma.page?.update) {
        await this.prisma.page.update({
          where: { id: canonicalPageId },
          data: updateData,
        });
      }
    }

    const nextTitle = cleanTitle ?? pageRow?.title ?? 'Untitled';
    const nextDescription = body.description ?? pageRow?.description ?? '';
    const nextStatus = body.status ?? pageRow?.status ?? 'draft';
    const nextCompiler = body.compiler ?? pageRow?.compiler ?? 'pdflatex';
    const nextTexlive = body.texlive ?? pageRow?.texlive ?? '2025';
    const nextSpellLang = body.spellLang ?? pageRow?.spellLang ?? 'en_US';
    const nextRootDocId = body.rootDocId ?? pageRow?.rootDocId ?? null;

    return {
      page: {
        id: canonicalPageId,
        title: nextTitle,
        description: nextDescription,
        status: nextStatus,
        compiler: nextCompiler,
        texlive: nextTexlive,
        spellLang: nextSpellLang,
        rootDocId: nextRootDocId,
        projectId: resolvedSpaceId,
        spaceId: resolvedSpaceId,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  public async updatePageContent(
    docId: string,
    body: UpdatePageContentParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(docId)) {
      throw new BadRequestException('A valid UUID is required for docId');
    }

    const hasNewContent =
      body.lines !== undefined || typeof body.content === 'string';

    // Metadata-only updates must NOT hydrate PageDoc.lines or bump PageDoc.version / PageDoc.rev
    if (!hasNewContent) {
      if (body.expectedRev !== undefined || body.expectedVersion !== undefined) {
        const targetProjectId = resolveActiveProjectId(authorizedProjectId);
        const record = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, docId)
          : await this.prisma.pageDoc.findUnique({ where: { id: docId } });
        if (record && !isRecordDeleted(record)) {
          await assertExpectedVersionAndRev(
            this.docstoreService,
            record,
            body.expectedRev,
            body.expectedVersion,
          );
        }
      }
      return await this.updatePageMetadata(docId, body, authorizedProjectId);
    }

    const targetProjectId = resolveActiveProjectId(authorizedProjectId);
    let record = targetProjectId
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, docId)
      : await this.prisma.pageDoc.findUnique({
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
    if (initialSpaceId) {
      const flushed = await this.liveCollab
        .flushDocs(initialSpaceId, [docId])
        .catch(() => []);
      if (Array.isArray(flushed) && flushed.length > 0) {
        const refreshed = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(targetProjectId, docId)
          : await this.prisma.pageDoc.findUnique({ where: { id: docId } });
        if (refreshed && !isRecordDeleted(refreshed)) {
          record = refreshed;
        }
      }
    }

    const recordProjectId = getRecordSpaceId(record);

    await assertExpectedVersionAndRev(
      this.docstoreService,
      record,
      body.expectedRev,
      body.expectedVersion,
    );

    let lines: string[];
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

    const result = await executeDocstoreUpdateWithOcc(
      this.docstoreService,
      record,
      lines,
      body.version,
      body.expectedRev,
    );

    const { cleanTitle, existingRanges } = await applyPageMetadataAndTitleUpdates(
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
        this.eventEmitter.emit('pages.project.event', {
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

  public async updateThumbnail(
    pageId: string,
    pdfThumbnail: string = '',
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (isUuid(pageId)) {
      try {
        const targetSpaceId = resolveActiveProjectId(authorizedProjectId);
        const directPage = targetSpaceId
          ? await this.pageRepo.findActivePageInSpace(targetSpaceId, pageId)
          : null;
        let canonicalPageId = directPage?.id;
        if (!canonicalPageId) {
          const record = targetSpaceId
            ? await this.pageScopeRepo.findDocInProject(targetSpaceId, pageId)
            : await this.prisma.pageDoc.findUnique({
                where: { id: pageId },
                select: { id: true, pageId: true, spaceId: true },
              });
          canonicalPageId = record?.pageId || pageId;
        }
        await this.pageRepo
          .updatePageThumbnail(canonicalPageId, pdfThumbnail, targetSpaceId)
          .catch(() => null);
      } catch {
        // Non-blocking thumbnail persistence
      }
    }

    return {
      page: {
        id: pageId,
        pdfThumbnail,
      },
    };
  }
}
