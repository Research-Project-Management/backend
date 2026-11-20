/**
 * modules/pages/core/services/page-files-transfer.helper.ts
 * File creation, deleted-file listing, and cross-project file/doc import helpers for PageService.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { type IFilesPort } from '@/modules/files';
import { LiveCollaborationPort } from '../ports/live-collaboration.port';
import {
  ensureCanonicalPageId,
  getRecordSpaceId,
  isPrismaUniqueConstraintError,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveCanonicalPageId,
  resolveProjectIdByEntityId,
} from '../page-scope.helper';
import { NodePathVo } from '@/modules/pages/structure/domain';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { hydratePageDocLines } from '@/modules/pages/docstore/services/doc-occ.helper';

export interface CreatePageFileParams {
  title?: string;
  name?: string;
  content?: string;
}

export interface ImportFromProjectParams {
  sourceProjectId?: string;
  sourceFileId: string;
  targetName?: string;
  targetPath?: string;
  parentPageId?: string;
}

export interface PageFilesTransferContext {
  readonly prisma: PrismaService;
  readonly docstoreService: DocstoreService;
  readonly liveCollab: LiveCollaborationPort;
  readonly eventEmitter?: EventEmitter2;
  readonly filesPort?: IFilesPort;
}

export async function createPageFileHelper(
  ctx: Pick<
    PageFilesTransferContext,
    'prisma' | 'docstoreService' | 'eventEmitter'
  >,
  pageId: string,
  body: CreatePageFileParams,
  authorizedProjectId?: string | { id: string } | null,
) {
  const fileName = body?.title || body?.name || 'untitled.tex';
  const content = body?.content || '';

  const projectId =
    resolveActiveProjectId(authorizedProjectId) ||
    (await resolveProjectIdByEntityId(ctx.prisma, pageId));
  const parentDocId = pageId;

  if (!projectId) {
    throw new NotFoundException(
      `Project not found for document or page ${pageId}`,
    );
  }

  const [existingPage, parentDoc] = await Promise.all([
    ctx.prisma.page?.findUnique
      ? Promise.resolve(
          ctx.prisma.page.findUnique({
            where: { id: parentDocId },
            select: { id: true, spaceId: true },
          }),
        ).catch(() => null)
      : Promise.resolve(null),
    ctx.prisma.pageDoc
      .findFirst({
        where: { id: parentDocId, spaceId: projectId },
        select: { pageId: true },
      })
      .catch(() => null),
  ]);
  const persistedPageId =
    (existingPage && existingPage.spaceId === projectId
      ? existingPage.id
      : undefined) ||
    (parentDoc as { pageId?: string | null } | null)?.pageId ||
    (await ensureCanonicalPageId(ctx.prisma, projectId, parentDocId));

  const parsed = NodePathVo.parse(fileName, 'untitled.tex');

  let createdDocResult: Awaited<ReturnType<DocstoreService['createDoc']>>;
  let createdNodeResult: { id: string };

  try {
    const txResult = await ctx.prisma.$transaction(async (tx) => {
      const txPageId = await ensureCanonicalPageId(
        tx,
        projectId,
        persistedPageId,
      );
      const parentId = await ensurePrismaFolderChain(
        tx,
        projectId,
        parsed.folderChain,
        txPageId,
      );

      const doc = await ctx.docstoreService.createDoc(projectId, {
        path: parsed.relativePath,
        text: content,
        version: 1,
        pageId: txPageId,
        tx,
      });

      const node = await tx.pageNode.create({
        data: {
          spaceId: projectId,
          pageId: txPageId,
          parentId,
          name: parsed.leafName,
          path: parsed.normalizedPath,
          depth: parsed.depth,
          type: 'DOC',
          docId: doc._id,
        },
      });

      return { doc, node };
    });

    createdDocResult = txResult.doc;
    createdNodeResult = txResult.node;
  } catch (createErr: unknown) {
    if (isPrismaUniqueConstraintError(createErr)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'DUPLICATE_NODE_PATH',
        message: `File path already exists: ${parsed.normalizedPath}`,
      });
    }
    throw createErr;
  }

  const createdDoc = createdDocResult;
  const nodeId = createdNodeResult.id;

  ctx.eventEmitter?.emit('pages.file-tree.change', {
    projectId,
    change: {
      action: 'create',
      node: {
        id: nodeId,
        docId: createdDoc._id,
        name: parsed.leafName,
        path: parsed.normalizedPath,
        type: 'DOC',
      },
    },
  });

  return {
    file: {
      id: createdDoc._id,
      nodeId,
      title: parsed.relativePath || parsed.leafName,
      name: parsed.leafName,
      path: parsed.normalizedPath,
      type: 'file',
      pageId: parentDocId,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function getDeletedFilesHelper(
  prisma: PrismaService,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
) {
  const projectId =
    resolveActiveProjectId(authorizedProjectId) ||
    (await resolveProjectIdByEntityId(prisma, pageId));

  if (!projectId) {
    return { files: [] };
  }

  const canonicalPageId = await resolveCanonicalPageId(
    prisma,
    projectId,
    pageId,
  );

  const [deletedDocs, deletedFiles] = await Promise.all([
    prisma.pageDoc.findMany({
      where: {
        spaceId: projectId,
        ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
        deletedAt: { not: null },
      },
      select: {
        id: true,
        lastKnownPath: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    prisma.pageFile.findMany({
      where: {
        spaceId: projectId,
        ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
        deletedAt: { not: null },
      },
      select: {
        id: true,
        lastKnownPath: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
  ]);

  const files = [
    ...deletedDocs.map((d) => ({
      id: d.id,
      pageId,
      title: d.lastKnownPath?.replace(/^\//, '') || 'document.tex',
      path: d.lastKnownPath,
      type: 'DOC',
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    ...deletedFiles.map((f) => ({
      id: f.id,
      pageId,
      title: f.lastKnownPath,
      path: `/${f.lastKnownPath}`,
      type: 'FILE',
      size: Number(f.sizeBytes || 0),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
  ];

  return { files };
}

export async function importFileFromProjectHelper(
  ctx: PageFilesTransferContext,
  targetProjectOrPageId: string,
  body: ImportFromProjectParams,
  authorizedProjectId?: string | { id: string } | null,
  userId?: string | null,
) {
  const sourceFileId = (body?.sourceFileId || '').trim();
  if (!sourceFileId) {
    throw new BadRequestException('sourceFileId is required');
  }

  const targetProjectId =
    resolveActiveProjectId(authorizedProjectId) ||
    (await resolveProjectIdByEntityId(ctx.prisma, targetProjectOrPageId));

  if (!targetProjectId) {
    throw new NotFoundException(
      `Target project not found for ${targetProjectOrPageId}`,
    );
  }

  // 1. Locate source node, doc, or binary file
  let sourceDoc = isUuid(sourceFileId)
    ? await ctx.prisma.pageDoc.findFirst({
        where: { id: sourceFileId, deletedAt: null },
        include: { node: true },
      })
    : null;

  let sourceBinaryFile =
    !sourceDoc && isUuid(sourceFileId)
      ? await ctx.prisma.pageFile.findFirst({
          where: { id: sourceFileId, deletedAt: null },
        })
      : null;

  if (!sourceDoc && !sourceBinaryFile && isUuid(sourceFileId)) {
    const sourceNode = await ctx.prisma.pageNode.findUnique({
      where: { id: sourceFileId },
      include: { doc: true },
    });
    if (sourceNode?.doc && !isRecordDeleted(sourceNode.doc)) {
      sourceDoc = { ...sourceNode.doc, node: sourceNode };
    } else if (sourceNode?.fileId) {
      sourceBinaryFile = await ctx.prisma.pageFile.findFirst({
        where: { id: sourceNode.fileId, deletedAt: null },
      });
    }
  }

  if (!sourceDoc && !sourceBinaryFile) {
    throw new NotFoundException(`Source file ${sourceFileId} not found`);
  }

  const resolvedSourceProjectId =
    getRecordSpaceId(sourceDoc) || getRecordSpaceId(sourceBinaryFile);
  if (
    body.sourceProjectId &&
    isUuid(body.sourceProjectId) &&
    resolvedSourceProjectId &&
    body.sourceProjectId !== resolvedSourceProjectId
  ) {
    const altSourceProjectId = await resolveProjectIdByEntityId(
      ctx.prisma,
      body.sourceProjectId,
    );
    if (altSourceProjectId && altSourceProjectId !== resolvedSourceProjectId) {
      throw new ForbiddenException(
        'Source file does not belong to specified sourceProjectId',
      );
    }
  }

  // Verify user has access to source project if userId is provided and projects differ
  if (
    userId &&
    resolvedSourceProjectId &&
    resolvedSourceProjectId !== targetProjectId &&
    resolvedSourceProjectId !== userId
  ) {
    const sourceProject = await ctx.prisma.project
      .findFirst({
        where: {
          id: resolvedSourceProjectId,
          OR: [{ createdById: userId }, { members: { some: { userId } } }],
        },
        select: { id: true },
      })
      .catch(() => ({ id: resolvedSourceProjectId }));
    if (!sourceProject) {
      throw new ForbiddenException(
        'Access denied to source project for file import',
      );
    }
  }

  if (sourceDoc) {
    const sourceDocProjectId = getRecordSpaceId(sourceDoc);
    if (ctx.liveCollab && sourceDocProjectId) {
      await ctx.liveCollab
        .flushDocs(sourceDocProjectId, [sourceDoc.id])
        .catch(() => []);
    }
    const lines = await hydratePageDocLines(ctx.docstoreService, sourceDoc);
    const content = lines.join('\n');
    const rawTargetName =
      body.targetPath ||
      body.targetName ||
      sourceDoc.node?.path ||
      sourceDoc.lastKnownPath ||
      sourceDoc.node?.name ||
      'imported.tex';

    return await createPageFileHelper(
      ctx,
      body.parentPageId || targetProjectId,
      {
        title: rawTargetName.replace(/^\/+/, ''),
        name: rawTargetName.replace(/^\/+/, ''),
        content,
      },
      targetProjectId,
    );
  }

  // Binary file copy via CAS reference in target project
  const bin = sourceBinaryFile!;
  const rawTargetName =
    body.targetPath || body.targetName || bin.lastKnownPath || 'imported.bin';
  const parsed = NodePathVo.parse(rawTargetName, 'imported.bin');

  const createdRecord = await ctx.prisma.$transaction(async (tx) => {
    const targetPageId = await ensureCanonicalPageId(
      tx,
      targetProjectId,
      body.parentPageId,
    );
    const parentId = await ensurePrismaFolderChain(
      tx,
      targetProjectId,
      parsed.folderChain,
      targetPageId,
    );

    const newFile = await tx.pageFile.create({
      data: {
        spaceId: targetProjectId,
        pageId: targetPageId,
        blobId: bin.blobId ?? null,
        lastKnownPath: parsed.relativePath || parsed.leafName,
        mimeType: bin.mimeType,
        sizeBytes: bin.sizeBytes,
        hash: bin.hash,
        storageKey: bin.storageKey,
        bucketName: bin.bucketName,
        rev: 0,
      },
    });

    const node = await tx.pageNode.create({
      data: {
        spaceId: targetProjectId,
        pageId: targetPageId,
        parentId,
        name: parsed.leafName,
        path: parsed.normalizedPath,
        depth: parsed.depth,
        type: 'FILE',
        fileId: newFile.id,
      },
    });

    return { newFile, node };
  });

  if (createdRecord) {
    if (bin.blobId && ctx.filesPort?.acquireBlob) {
      await ctx.filesPort.acquireBlob(bin.blobId).catch(() => undefined);
    }
    const importedBytes = Number(bin.sizeBytes ?? 0);
    if (importedBytes > 0 && ctx.filesPort?.reserveQuota) {
      await ctx.filesPort
        .reserveQuota(targetProjectId, BigInt(importedBytes))
        .catch(() => undefined);
    }
  }

  ctx.eventEmitter?.emit('pages.file-tree.change', {
    projectId: targetProjectId,
    change: {
      action: 'create',
      node: {
        id: createdRecord.node.id,
        fileId: createdRecord.newFile.id,
        name: parsed.leafName,
        path: parsed.normalizedPath,
        type: 'FILE',
      },
    },
  });

  return {
    file: {
      id: createdRecord.newFile.id,
      nodeId: createdRecord.node.id,
      fileId: createdRecord.newFile.id,
      title: parsed.relativePath || parsed.leafName,
      name: parsed.leafName,
      path: parsed.normalizedPath,
      type: 'FILE',
      sizeBytes: bin.sizeBytes,
      mimeType: bin.mimeType,
      createdAt: createdRecord.newFile.createdAt.toISOString(),
      updatedAt: createdRecord.newFile.updatedAt.toISOString(),
    },
  };
}
