/**
 * modules/pages/core/services/page-trash-clone.helper.ts
 * Trash restoration and deep page duplication helpers.
 */

import * as crypto from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PageDoc, PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { type IFilesPort } from '@/modules/files';
import {
  ensureCanonicalPageId,
  getRecordSpaceId,
  isRecordDeleted,
  type PageScopeDbClient,
} from '../page-scope.helper';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { hydratePageDocLines } from '@/modules/pages/docstore/services/doc-occ.helper';

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
  filesPort?: IFilesPort,
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

    if (wasDeleted && filesPort) {
      const fileBlobId = (file as { blobId?: string | null }).blobId;
      if (fileBlobId) {
        await Promise.resolve(filesPort.acquireBlob(fileBlobId)).catch(
          () => undefined,
        );
      }
      const restoredSize = Number(file.sizeBytes ?? 0);
      if (restoredSize > 0) {
        await Promise.resolve(
          filesPort.reserveQuota(fileProjectId, BigInt(restoredSize)),
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
  filesPort?: IFilesPort,
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
  const blobIncrements = new Map<string, number>();

  await prisma.$transaction(async (tx) => {
    blobIncrements.clear();
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

  if (filesPort && blobIncrements.size > 0) {
    for (const [blobId, incrementBy] of blobIncrements.entries()) {
      for (let i = 0; i < incrementBy; i++) {
        await Promise.resolve(filesPort.acquireBlob(blobId)).catch(() => null);
      }
    }
  }

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
