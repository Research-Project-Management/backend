/**
 * modules/pages/page/services/duplicate.service.ts
 * Domain service deep-cloning a Page aggregate root, its documents, CAS files, and virtual tree.
 */

import * as crypto from 'crypto';
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, PageDoc } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  NodePathVo,
  ensureCanonicalPageId,
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
} from '@/modules/pages/core';
import {
  DocstoreService,
  ScopeRepository,
  hydratePageDocLines,
} from '@/modules/pages/docstore';

interface DuplicatePageSourceInput {
  spaceId: string;
  sourcePageId: string;
  sourcePageRow?: {
    id: string;
    spaceId?: string;
    rootDocId?: string | null;
    title?: string | null;
    description?: string | null;
    compiler?: string | null;
    texlive?: string | null;
    spellLang?: string | null;
    settings?: unknown;
    createdById?: string | null;
  } | null;
  fallbackDoc?: PageDoc | null;
  actorId?: string | null;
}

export interface ClonePlanInput {
  spaceId: string;
  newPageId: string;
  newPageTitle: string;
  sourceDocs: Array<{
    id: string;
    lastKnownPath: string;
    lines: unknown;
    ranges: unknown;
    hash: string | null;
    sizeBytes: number;
  }>;
  sourceRootDocId: string | null;
  hydratedDocLinesById: ReadonlyMap<string, string[]>;
  sourceFiles: Array<{
    id: string;
    blobId?: string | null;
    lastKnownPath: string;
    mimeType: string;
    sizeBytes: number;
    hash: string;
    storageKey: string;
    bucketName: string;
  }>;
  sourceNodes: Array<{
    id: string;
    parentId: string | null;
    type: 'FOLDER' | 'DOC' | 'FILE';
    name: string;
    path: string;
    depth?: number | null;
    docId: string | null;
    fileId: string | null;
    sortOrder?: number | null;
  }>;
  generateId?: () => string;
}

export interface ClonePlanResult {
  clonedRootDocId: string | null;
  docsToCreate: Prisma.PageDocCreateManyInput[];
  filesToCreate: Prisma.PageFileCreateManyInput[];
  nodeBatchesByDepth: Map<number, Prisma.PageNodeCreateManyInput[]>;
  blobIncrements: Map<string, number>;
}

/**
 * Pure Prototype Cloner planner (zero I/O, zero side effects):
 * Computes O(1)-batchable PageDoc & PageFile rows and BFS depth-grouped PageNode batches
 * so parent rows are always inserted before children in O(depth) DB round-trips.
 */
export function buildClonePlan(input: ClonePlanInput): ClonePlanResult {
  const genId = input.generateId ?? (() => crypto.randomUUID());
  const docIdMap = new Map<string, string>();
  const docsToCreate: Prisma.PageDocCreateManyInput[] = [];
  let clonedRootDocId: string | null = null;

  for (let idx = 0; idx < input.sourceDocs.length; idx++) {
    const doc = input.sourceDocs[idx];
    const isRootDoc = input.sourceRootDocId
      ? doc.id === input.sourceRootDocId
      : idx === 0;
    const newDocId = isRootDoc ? input.newPageId : genId();
    docIdMap.set(doc.id, newDocId);
    if (isRootDoc) {
      clonedRootDocId = newDocId;
    }

    const hydratedLines =
      input.hydratedDocLinesById.get(doc.id) ??
      (Array.isArray(doc.lines) ? (doc.lines as string[]) : []);
    const baseRanges =
      doc.ranges && typeof doc.ranges === 'object'
        ? (doc.ranges as Record<string, unknown>)
        : {};
    const clonedRanges = isRootDoc
      ? { ...baseRanges, title: input.newPageTitle }
      : baseRanges;

    docsToCreate.push({
      id: newDocId,
      spaceId: input.spaceId,
      pageId: input.newPageId,
      lastKnownPath: doc.lastKnownPath,
      lines: hydratedLines,
      rev: 1,
      version: 1,
      ranges: clonedRanges as Prisma.InputJsonValue,
      hash: doc.hash,
      sizeBytes: doc.sizeBytes,
      inStorage: false,
      storageKey: null,
    });
  }

  const fileIdMap = new Map<string, string>();
  const filesToCreate: Prisma.PageFileCreateManyInput[] = [];
  const blobIncrements = new Map<string, number>();

  for (const file of input.sourceFiles) {
    const newFileId = genId();
    fileIdMap.set(file.id, newFileId);
    filesToCreate.push({
      id: newFileId,
      spaceId: input.spaceId,
      pageId: input.newPageId,
      blobId: file.blobId ?? null,
      lastKnownPath: file.lastKnownPath,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      hash: file.hash,
      storageKey: file.storageKey,
      bucketName: file.bucketName,
      rev: 0,
    });
    if (file.blobId) {
      blobIncrements.set(
        file.blobId,
        (blobIncrements.get(file.blobId) ?? 0) + 1,
      );
    }
  }

  // BFS depth-order grouping: guarantees every parentId is mapped before its children
  const orderedNodes = [...input.sourceNodes].sort(
    (a, b) => (a.depth ?? 1) - (b.depth ?? 1),
  );
  const nodeIdMap = new Map<string, string>();
  const nodeBatchesByDepth = new Map<
    number,
    Prisma.PageNodeCreateManyInput[]
  >();

  for (const node of orderedNodes) {
    const mappedParentId = node.parentId
      ? (nodeIdMap.get(node.parentId) ?? null)
      : null;
    if (node.parentId && !mappedParentId) continue;

    const mappedDocId = node.docId ? (docIdMap.get(node.docId) ?? null) : null;
    const mappedFileId = node.fileId
      ? (fileIdMap.get(node.fileId) ?? null)
      : null;

    if (node.type === 'DOC' && !mappedDocId) continue;
    if (node.type === 'FILE' && !mappedFileId) continue;

    const newNodeId = genId();
    nodeIdMap.set(node.id, newNodeId);
    const depth = Math.max(1, node.depth || 1);
    const batch = nodeBatchesByDepth.get(depth) ?? [];
    batch.push({
      id: newNodeId,
      spaceId: input.spaceId,
      pageId: input.newPageId,
      parentId: mappedParentId,
      type: node.type,
      name: node.name,
      path: node.path,
      depth,
      docId: mappedDocId,
      fileId: mappedFileId,
      sortOrder: node.sortOrder ?? 0,
    });
    nodeBatchesByDepth.set(depth, batch);
  }

  return {
    clonedRootDocId,
    docsToCreate,
    filesToCreate,
    nodeBatchesByDepth,
    blobIncrements,
  };
}

@Injectable()
export class PageDuplicateService {
  private readonly pageScopeRepo: ScopeRepository;
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {
    this.pageScopeRepo = pageScopeRepo ?? new ScopeRepository(prisma);
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

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

    const targetProjectId = resolveActiveProjectId(authorizedProjectId);

    const directPageRow = this.prisma.page?.findUnique
      ? await Promise.resolve(
          this.prisma.page.findUnique({
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
      ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
      : await this.prisma.pageDoc.findUnique({
          where: { id: pageId },
        });

    if (
      (!entryDoc || isRecordDeleted(entryDoc)) &&
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

    let validEntryDoc =
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
        !isRecordDeleted(lookedUpPage) &&
        getRecordSpaceId(lookedUpPage) === spaceId
      ) {
        sourcePageRow = lookedUpPage;
      }
    }

    // Live-Flush Invariant: flush all active Yjs sessions of the source Page BEFORE reading PageDoc.lines
    // so unsaved live edits are persisted and included in the cloned Page.
    if (spaceId) {
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
          ...(sourcePageRow?.rootDocId ? [sourcePageRow.rootDocId] : []),
          ...(validEntryDoc?.id ? [validEntryDoc.id] : [pageId]),
        ]),
      );
      const flushedIds = await this.liveCollab
        .flushDocs(spaceId, docIdsToFlush)
        .catch((): string[] => []);
      if (
        Array.isArray(flushedIds) &&
        flushedIds.length > 0 &&
        validEntryDoc &&
        flushedIds.includes(validEntryDoc.id)
      ) {
        const refreshedEntry = targetProjectId
          ? await this.pageScopeRepo.findDocInProject(
              targetProjectId,
              validEntryDoc.id,
            )
          : await this.prisma.pageDoc.findUnique({
              where: { id: validEntryDoc.id },
            });
        if (refreshedEntry && !isRecordDeleted(refreshedEntry)) {
          validEntryDoc = refreshedEntry;
        }
      }
    }

    return this.cloneSourcePageTree({
      spaceId,
      sourcePageId,
      sourcePageRow,
      fallbackDoc: validEntryDoc,
      actorId: userId,
    });
  }

  private async cloneSourcePageTree(input: DuplicatePageSourceInput) {
    const { spaceId, sourcePageId, sourcePageRow, fallbackDoc, actorId } =
      input;
    const validActorId = actorId && isUuid(actorId) ? actorId : null;

    const [fetchedDocs, fetchedFiles, fetchedNodes] = await Promise.all([
      this.prisma.pageDoc?.findMany
        ? Promise.resolve(
            this.prisma.pageDoc.findMany({
              where: { spaceId, pageId: sourcePageId, deletedAt: null },
              orderBy: { createdAt: 'asc' },
            }),
          ).catch(() => null)
        : Promise.resolve(null),
      this.prisma.pageFile?.findMany
        ? Promise.resolve(
            this.prisma.pageFile.findMany({
              where: { spaceId, pageId: sourcePageId, deletedAt: null },
              orderBy: { createdAt: 'asc' },
            }),
          ).catch(() => [])
        : Promise.resolve([]),
      this.prisma.pageNode?.findMany
        ? Promise.resolve(
            this.prisma.pageNode.findMany({
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
    if (this.prisma.page?.findMany) {
      const existingPages = await Promise.resolve(
        this.prisma.page.findMany({
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

    const hydratedEntries = await Promise.all(
      sourceDocs.map(
        async (doc): Promise<[string, string[]]> => [
          doc.id,
          await hydratePageDocLines(this.docstoreService, doc),
        ],
      ),
    );
    const hydratedDocLinesById = new Map<string, string[]>(hydratedEntries);

    const newPageId = crypto.randomUUID();
    const rootFilePath =
      sourceRootDoc?.lastKnownPath ||
      (sourceRootDoc as { path?: string } | undefined)?.path ||
      'main.tex';
    const rootFileName = NodePathVo.toRelative(rootFilePath) || 'main.tex';
    const nowIso = new Date().toISOString();

    const plan = buildClonePlan({
      spaceId,
      newPageId,
      newPageTitle,
      sourceDocs,
      sourceRootDocId: sourceRootDoc?.id ?? null,
      hydratedDocLinesById,
      sourceFiles,
      sourceNodes,
    });

    let totalClonedBytes = 0n;
    for (const file of sourceFiles) {
      const fileSize = Math.max(0, Number(file.sizeBytes ?? 0));
      if (fileSize > 0) {
        totalClonedBytes += BigInt(fileSize);
      }
    }

    let quotaReserved = false;
    if (
      totalClonedBytes > 0n &&
      typeof this.filesPort?.reserveQuota === 'function'
    ) {
      await this.filesPort.reserveQuota(spaceId, totalClonedBytes);
      quotaReserved = true;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Single-transaction Prisma batch clone (O(2 + depth) DB round-trips)
        if (tx.page?.create || tx.page?.upsert) {
          const pagePayload = {
            id: newPageId,
            spaceId,
            rootDocId: null,
            title: newPageTitle,
            description: sourcePageRow?.description ?? null,
            status: 'draft' as const,
            compiler: sourcePageRow?.compiler || 'pdflatex',
            texlive: sourcePageRow?.texlive || '2025',
            spellLang: sourcePageRow?.spellLang || 'en_US',
            settings:
              (sourcePageRow?.settings as Prisma.InputJsonValue | undefined) ??
              {},
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

        if (plan.docsToCreate.length > 0) {
          if (tx.pageDoc?.createMany) {
            await tx.pageDoc.createMany({ data: plan.docsToCreate });
          } else if (tx.pageDoc?.create) {
            for (const docData of plan.docsToCreate) {
              await tx.pageDoc.create({ data: docData });
            }
          }
        }

        if (plan.clonedRootDocId && (tx.page?.updateMany || tx.page?.update)) {
          if (tx.page.updateMany) {
            await tx.page.updateMany({
              where: { id: newPageId, spaceId },
              data: { rootDocId: plan.clonedRootDocId },
            });
          } else if (tx.page.update) {
            await tx.page.update({
              where: { id: newPageId },
              data: { rootDocId: plan.clonedRootDocId },
            });
          }
        }

        if (plan.filesToCreate.length > 0) {
          if (tx.pageFile?.createMany) {
            await tx.pageFile.createMany({ data: plan.filesToCreate });
          } else if (tx.pageFile?.create) {
            for (const fileData of plan.filesToCreate) {
              await tx.pageFile.create({ data: fileData });
            }
          }
        }

        const sortedDepths = Array.from(plan.nodeBatchesByDepth.keys()).sort(
          (a, b) => a - b,
        );
        for (const depth of sortedDepths) {
          const batch = plan.nodeBatchesByDepth.get(depth);
          if (!batch || batch.length === 0) continue;
          if (tx.pageNode?.createMany) {
            await tx.pageNode.createMany({ data: batch });
          } else if (tx.pageNode?.create) {
            for (const nodeData of batch) {
              await tx.pageNode.create({ data: nodeData });
            }
          }
        }
      });
    } catch (err) {
      if (quotaReserved && typeof this.filesPort?.releaseQuota === 'function') {
        await Promise.resolve(
          this.filesPort.releaseQuota(spaceId, totalClonedBytes),
        ).catch(() => undefined);
      }
      throw err;
    }

    if (this.filesPort && plan.blobIncrements.size > 0) {
      const acquireCalls: Array<Promise<unknown>> = [];
      for (const [blobId, incrementBy] of plan.blobIncrements.entries()) {
        for (let i = 0; i < incrementBy; i++) {
          acquireCalls.push(
            Promise.resolve(this.filesPort.acquireBlob(blobId)).catch(
              () => null,
            ),
          );
        }
      }
      await Promise.all(acquireCalls);
    }

    const rootLines = sourceRootDoc
      ? (hydratedDocLinesById.get(sourceRootDoc.id) ?? [])
      : [];
    const content = rootLines.join('\n');

    this.eventEmitter?.emit('pages.file-tree.change', {
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
}
