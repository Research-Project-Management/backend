/**
 * modules/pages/page/services/file.service.ts
 * Domain service creating child page files and importing documents/files across spaces.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type PageDoc, type PageFile, type PageNode } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  NodePathVo,
  ensureCanonicalPageId,
  ensurePrismaFolderChain,
  getRecordSpaceId,
  hydratePageDocLines,
  isPrismaUniqueConstraintError,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveProjectIdByEntityId,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  type CreatePageFileParams,
  type ImportFromProjectParams,
} from '../types/page.types';
export type { CreatePageFileParams, ImportFromProjectParams };

type SourcePageDocRecord = PageDoc & { node: PageNode | null };

@Injectable()
export class PageFileService {
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  public async createPageFile(
    pageId: string,
    body: CreatePageFileParams,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    const fileName = body?.title || body?.name || 'untitled.tex';
    const content = body?.content || '';

    const projectId =
      resolveActiveProjectId(authorizedProjectId) ||
      (await resolveProjectIdByEntityId(this.prisma, pageId));
    const parentDocId = pageId;

    if (!projectId) {
      throw new NotFoundException(
        `Project not found for document or page ${pageId}`,
      );
    }

    const [existingPage, parentDoc] = await Promise.all([
      this.prisma.page?.findUnique
        ? Promise.resolve(
            this.prisma.page.findUnique({
              where: { id: parentDocId },
              select: { id: true, spaceId: true },
            }),
          ).catch(() => null)
        : Promise.resolve(null),
      this.prisma.pageDoc
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
      (await ensureCanonicalPageId(this.prisma, projectId, parentDocId));

    const parsed = NodePathVo.parse(fileName, 'untitled.tex');

    let createdDocResult: Awaited<ReturnType<DocstoreService['createDoc']>>;
    let createdNodeResult: { id: string };

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
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

        const doc = await this.docstoreService.createDoc(projectId, {
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

    this.eventEmitter?.emit('pages.file-tree.change', {
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

  public async importFileFromProject(
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
      (await resolveProjectIdByEntityId(this.prisma, targetProjectOrPageId));

    if (!targetProjectId) {
      throw new NotFoundException(
        `Target project not found for ${targetProjectOrPageId}`,
      );
    }

    let sourceDoc = isUuid(sourceFileId)
      ? await this.prisma.pageDoc.findFirst({
          where: { id: sourceFileId, deletedAt: null },
          include: { node: true },
        })
      : null;

    let sourceBinaryFile =
      !sourceDoc && isUuid(sourceFileId)
        ? await this.prisma.pageFile.findFirst({
            where: { id: sourceFileId, deletedAt: null },
          })
        : null;

    if (!sourceDoc && !sourceBinaryFile && isUuid(sourceFileId)) {
      const sourceNode = await this.prisma.pageNode.findUnique({
        where: { id: sourceFileId },
        include: { doc: true },
      });
      if (sourceNode?.doc && !isRecordDeleted(sourceNode.doc)) {
        sourceDoc = { ...sourceNode.doc, node: sourceNode };
      } else if (sourceNode?.fileId) {
        sourceBinaryFile = await this.prisma.pageFile.findFirst({
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
        this.prisma,
        body.sourceProjectId,
      );
      if (altSourceProjectId && altSourceProjectId !== resolvedSourceProjectId) {
        throw new ForbiddenException(
          'Source file does not belong to specified sourceProjectId',
        );
      }
    }

    // Fail-closed cross-tenant authorization when importing from another space
    if (
      resolvedSourceProjectId &&
      resolvedSourceProjectId !== targetProjectId &&
      resolvedSourceProjectId !== userId
    ) {
      if (!userId) {
        throw new ForbiddenException(
          'Authentication required to import files across spaces',
        );
      }
      const sourceProject = await this.prisma.project.findFirst({
        where: {
          id: resolvedSourceProjectId,
          OR: [{ createdById: userId }, { members: { some: { userId } } }],
        },
        select: { id: true },
      });
      if (!sourceProject) {
        throw new ForbiddenException(
          'Access denied to source project for file import',
        );
      }
    }

    if (sourceDoc) {
      return this.importTextDocument(targetProjectId, body, sourceDoc);
    }
    return this.importBinaryFile(targetProjectId, body, sourceBinaryFile!);
  }

  private async importTextDocument(
    targetProjectId: string,
    body: ImportFromProjectParams,
    sourceDoc: SourcePageDocRecord,
  ) {
    const sourceDocProjectId = getRecordSpaceId(sourceDoc);
    if (sourceDocProjectId) {
      await this.liveCollab
        .flushDocs(sourceDocProjectId, [sourceDoc.id])
        .catch(() => []);
    }
    const lines = await hydratePageDocLines(this.docstoreService, sourceDoc);
    const content = lines.join('\n');
    const rawTargetName =
      body.targetPath ||
      body.targetName ||
      sourceDoc.node?.path ||
      sourceDoc.lastKnownPath ||
      sourceDoc.node?.name ||
      'imported.tex';

    return this.createPageFile(
      body.parentPageId || targetProjectId,
      {
        title: rawTargetName.replace(/^\/+/, ''),
        name: rawTargetName.replace(/^\/+/, ''),
        content,
      },
      targetProjectId,
    );
  }

  private async importBinaryFile(
    targetProjectId: string,
    body: ImportFromProjectParams,
    bin: PageFile,
  ) {
    const rawTargetName =
      body.targetPath || body.targetName || bin.lastKnownPath || 'imported.bin';
    const parsed = NodePathVo.parse(rawTargetName, 'imported.bin');

    const createdRecord = await this.prisma.$transaction(async (tx) => {
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
      if (bin.blobId && this.filesPort?.acquireBlob) {
        await this.filesPort.acquireBlob(bin.blobId).catch(() => undefined);
      }
      const importedBytes = Number(bin.sizeBytes ?? 0);
      if (importedBytes > 0 && this.filesPort?.reserveQuota) {
        await this.filesPort
          .reserveQuota(targetProjectId, BigInt(importedBytes))
          .catch(() => undefined);
      }
    }

    this.eventEmitter?.emit('pages.file-tree.change', {
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
}
