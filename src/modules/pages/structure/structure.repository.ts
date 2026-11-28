/**
 * modules/pages/structure/structure.repository.ts
 * Direct Injectable Repository for Page Virtual Tree & Hierarchy.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  NodePathVo,
  ensureCanonicalPageId,
  filterRecordsByPageScope,
} from '@/modules/pages/core';
import { CreateNodeParams } from './domain/structure.ports';
import { PageNodeEntity } from './domain/node.entity';
import {
  NODE_HYDRATION_INCLUDE,
  type HydratedPageNodeRow,
  ensurePrismaFolderChain,
  mapHydratedRowToPageNodeEntity,
} from './repositories/folder-chain';
import {
  deleteSubtreeHelper,
  moveSubtreeHelper,
  renameSingleNodeHelper,
} from './repositories/subtree-mutation';

export { ensurePrismaFolderChain };

@Injectable()
export class StructureRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async createNode(params: CreateNodeParams): Promise<PageNodeEntity> {
    const depth = NodePathVo.depth(params.path);
    const canonicalPageId = await ensureCanonicalPageId(
      this.prisma,
      params.projectId,
      params.pageId,
    );
    const created = await this.prisma.pageNode.create({
      data: {
        spaceId: params.projectId,
        pageId: canonicalPageId,
        parentId: params.parentId || null,
        type: params.type,
        name: params.name,
        path: params.path,
        depth,
        docId: params.docId || null,
        fileId: params.fileId || null,
        sortOrder: params.sortOrder || 0,
      },
      include: NODE_HYDRATION_INCLUDE,
    });

    if (
      params.isRootDoc &&
      params.type === 'DOC' &&
      created.docId &&
      this.prisma.page?.updateMany
    ) {
      await Promise.resolve(
        this.prisma.page.updateMany({
          where: { id: canonicalPageId, spaceId: params.projectId },
          data: { rootDocId: created.docId },
        }),
      ).catch(() => null);
    }

    return mapHydratedRowToPageNodeEntity(created, {
      isRootDoc: Boolean(params.isRootDoc && params.type === 'DOC'),
      sizeBytes: params.sizeBytes,
      hash: params.hash,
    });
  }

  public async findById(
    projectId: string,
    nodeId: string,
  ): Promise<PageNodeEntity | null> {
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        OR: [{ id: nodeId }, { docId: nodeId }, { fileId: nodeId }],
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    if (raw) return mapHydratedRowToPageNodeEntity(raw);

    const byPage = await this.prisma.pageNode
      .findFirst({
        where: {
          pageId: projectId,
          OR: [{ id: nodeId }, { docId: nodeId }, { fileId: nodeId }],
        },
        include: NODE_HYDRATION_INCLUDE,
      })
      .catch(() => null);
    return byPage ? mapHydratedRowToPageNodeEntity(byPage) : null;
  }

  public async findByPath(
    projectId: string,
    path: string,
    pageId?: string | null,
  ): Promise<PageNodeEntity | null> {
    const normalized = NodePathVo.normalize(path);
    const trimmedPageId = pageId?.trim() || undefined;
    if (trimmedPageId) {
      const scoped = await this.prisma.pageNode.findFirst({
        where: { spaceId: projectId, pageId: trimmedPageId, path: normalized },
        include: NODE_HYDRATION_INCLUDE,
      });
      return scoped ? mapHydratedRowToPageNodeEntity(scoped) : null;
    }
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        OR: [
          { spaceId: projectId, path: normalized },
          { pageId: projectId, path: normalized },
        ],
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    return raw ? mapHydratedRowToPageNodeEntity(raw) : null;
  }

  public async findByFileId(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<PageNodeEntity | null> {
    const trimmedPageId = pageId?.trim() || undefined;
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        fileId,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    return raw ? mapHydratedRowToPageNodeEntity(raw) : null;
  }

  public async getAllNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<PageNodeEntity[]> {
    const trimmedPageId = pageId?.trim() || undefined;
    const nodes = await this.prisma.pageNode.findMany({
      where: trimmedPageId
        ? { spaceId: projectId, pageId: trimmedPageId }
        : { spaceId: projectId },
      include: NODE_HYDRATION_INCLUDE,
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const activeNodes = trimmedPageId
      ? nodes
      : nodes.filter(
          (n) => !(n as HydratedPageNodeRow).page?.deletedAt,
        );
    const scoped = trimmedPageId
      ? filterRecordsByPageScope(activeNodes, trimmedPageId, projectId)
      : activeNodes;
    return scoped.map((n) =>
      mapHydratedRowToPageNodeEntity(n as HydratedPageNodeRow),
    );
  }

  public async getRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<PageNodeEntity | null> {
    const trimmedPageId = pageId?.trim() || undefined;
    const pageRow =
      this.prisma.page?.findUnique || this.prisma.page?.findFirst
        ? await Promise.resolve(
            trimmedPageId && this.prisma.page.findUnique
              ? this.prisma.page.findUnique({
                  where: { id: trimmedPageId },
                  select: {
                    id: true,
                    spaceId: true,
                    rootDocId: true,
                    deletedAt: true,
                  },
                })
              : this.prisma.page.findFirst?.({
                  where: {
                    spaceId: projectId,
                    ...(trimmedPageId ? { id: trimmedPageId } : {}),
                    deletedAt: null,
                  },
                  orderBy: { createdAt: 'asc' },
                  select: {
                    id: true,
                    spaceId: true,
                    rootDocId: true,
                    deletedAt: true,
                  },
                }),
          ).catch(() => null)
        : null;

    if (
      !pageRow ||
      pageRow.deletedAt ||
      (pageRow.spaceId && pageRow.spaceId !== projectId) ||
      !pageRow.rootDocId
    ) {
      return null;
    }

    const rootNode = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        pageId: pageRow.id,
        docId: pageRow.rootDocId,
        type: 'DOC',
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    return rootNode
      ? mapHydratedRowToPageNodeEntity(rootNode, { isRootDoc: true })
      : null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    const targetNode = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        OR: [{ id: nodeId }, { docId: nodeId }],
      },
    });

    if (!targetNode || !targetNode.docId) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }

    const targetPageId =
      targetNode.pageId ||
      (await ensureCanonicalPageId(this.prisma, projectId));

    if (this.prisma.page?.updateMany) {
      await this.prisma.page.updateMany({
        where: { id: targetPageId, spaceId: projectId },
        data: { rootDocId: targetNode.docId },
      });
    }
  }

  public async unsetRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<void> {
    const trimmedPageId = pageId?.trim() || undefined;
    if (this.prisma.page?.updateMany) {
      await this.prisma.page.updateMany({
        where: {
          spaceId: projectId,
          ...(trimmedPageId ? { id: trimmedPageId } : {}),
          rootDocId: { not: null },
        },
        data: { rootDocId: null },
      });
    }
  }

  public async moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null,
    options?: { nodeId?: string; pageId?: string | null },
  ): Promise<void> {
    await moveSubtreeHelper(
      this.prisma,
      projectId,
      sourcePath,
      destPath,
      newParentId,
      options,
    );
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string,
  ): Promise<PageNodeEntity> {
    const normalizedNewPath = NodePathVo.normalize(newPath);
    if (typeof this.prisma.pageNode?.findFirst === 'function') {
      const existingTarget = await this.findById(projectId, nodeId);
      if (!existingTarget) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'Node not found in project',
        });
      }
      if (
        existingTarget.isFolder() &&
        existingTarget.path !== normalizedNewPath
      ) {
        await this.moveSubtree(
          projectId,
          existingTarget.path,
          normalizedNewPath,
          existingTarget.parentId,
          { nodeId, pageId: existingTarget.pageId },
        );
        return (await this.findById(projectId, nodeId))!;
      }
    }

    return await renameSingleNodeHelper(
      this.prisma,
      projectId,
      nodeId,
      newName,
      normalizedNewPath,
    );
  }

  public async deleteSubtree(
    projectId: string,
    path: string,
    pageId?: string | null,
  ): Promise<PageNodeEntity[]> {
    return await deleteSubtreeHelper(this.prisma, projectId, path, pageId);
  }

  public async updateSortOrder(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void> {
    const result = await this.prisma.pageNode.updateMany({
      where: { id: nodeId, spaceId: projectId },
      data: { sortOrder },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
  }

  public async updateNodeFileId(
    projectId: string,
    nodeId: string,
    fileId: string,
    sizeBytes?: number,
    hash?: string | null,
  ): Promise<PageNodeEntity> {
    const result = await this.prisma.pageNode.updateMany({
      where: { id: nodeId, spaceId: projectId },
      data: {
        fileId,
      },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
    const updated = await this.prisma.pageNode.findFirst({
      where: { id: nodeId, spaceId: projectId },
      include: NODE_HYDRATION_INCLUDE,
    });
    return mapHydratedRowToPageNodeEntity(updated!, {
      sizeBytes,
      hash,
    });
  }

  public async countNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<number> {
    const trimmedPageId = pageId?.trim() || undefined;
    if (trimmedPageId) {
      return await this.prisma.pageNode.count({
        where: { spaceId: projectId, pageId: trimmedPageId },
      });
    }
    return await this.prisma.pageNode.count({
      where: { spaceId: projectId },
    });
  }

  public async docExistsInProject(
    projectId: string,
    docId: string,
    pageId?: string | null,
  ): Promise<boolean> {
    const trimmedPageId = pageId?.trim() || undefined;
    const doc = await this.prisma.pageDoc.findFirst({
      where: {
        id: docId,
        spaceId: projectId,
        deletedAt: null,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
      select: { id: true },
    });
    return Boolean(doc);
  }

  public async fileExistsInProject(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<boolean> {
    const trimmedPageId = pageId?.trim() || undefined;
    const file = await this.prisma.pageFile.findFirst({
      where: {
        id: fileId,
        spaceId: projectId,
        deletedAt: null,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
      select: { id: true },
    });
    return Boolean(file);
  }
}
