/**
 * modules/manuscripts/structure/structure.repository.ts
 * Direct Injectable Repository for Manuscript Project File Tree & Hierarchy.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { ManuscriptNode, Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  IStructureRepository,
  CreateNodeParams,
  ManuscriptNodeEntity,
  NodePathVo,
  ParsedFolderSegment,
} from './domain';

/**
 * Shared Prisma folder-chain materializer (`mkdir -p` for `ManuscriptNode` folders).
 * Safe to invoke on both `PrismaService` and transaction clients (`tx`), and preserves
 * optional-chaining (`findUnique?.`) for lightweight unit test mocks.
 */
export async function ensurePrismaFolderChain(
  db: { manuscriptNode?: Partial<Prisma.TransactionClient['manuscriptNode']> } | null | undefined,
  projectId: string,
  folderChain: readonly ParsedFolderSegment[],
): Promise<string | null> {
  if (!db?.manuscriptNode || folderChain.length === 0) {
    return null;
  }
  let parentId: string | null = null;
  for (const folder of folderChain) {
    let folderNode = await db.manuscriptNode.findUnique?.({
      where: {
        projectId_path: {
          projectId,
          path: folder.path,
        },
      },
    });
    if (!folderNode && db.manuscriptNode.create) {
      folderNode = await db.manuscriptNode
        .create({
          data: {
            projectId,
            parentId,
            type: 'FOLDER',
            name: folder.name,
            path: folder.path,
            depth: folder.depth,
            isRootDoc: false,
            sizeBytes: 0,
            sortOrder: 0,
          },
        })
        .catch(() => null);
    }
    parentId = folderNode?.id ?? parentId;
  }
  return parentId;
}

@Injectable()
export class StructureRepository extends IStructureRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private async syncBackingAssetPath(
    db: Pick<Prisma.TransactionClient, 'manuscriptDoc' | 'manuscriptFile'>,
    projectId: string,
    node: { docId?: string | null; fileId?: string | null } | null | undefined,
    virtualPath: string,
  ): Promise<void> {
    if (!node) return;
    const relativePath = NodePathVo.toRelative(virtualPath);
    if (node.docId) {
      await db.manuscriptDoc?.updateMany({
        where: { id: node.docId, projectId },
        data: { path: relativePath },
      });
    }
    if (node.fileId) {
      await db.manuscriptFile?.updateMany({
        where: { id: node.fileId, projectId },
        data: { name: relativePath },
      });
    }
  }

  private mapToEntity(raw: ManuscriptNode): ManuscriptNodeEntity {
    return new ManuscriptNodeEntity({
      id: raw.id,
      projectId: raw.projectId,
      parentId: raw.parentId,
      type: raw.type,
      name: raw.name,
      path: raw.path,
      depth: raw.depth,
      docId: raw.docId,
      fileId: raw.fileId,
      isRootDoc: raw.isRootDoc,
      sizeBytes: Number(raw.sizeBytes || 0),
      hash: raw.hash,
      sortOrder: raw.sortOrder,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  public async createNode(
    params: CreateNodeParams,
  ): Promise<ManuscriptNodeEntity> {
    const depth = NodePathVo.depth(params.path);
    const created = await this.prisma.manuscriptNode.create({
      data: {
        projectId: params.projectId,
        parentId: params.parentId || null,
        type: params.type,
        name: params.name,
        path: params.path,
        depth,
        docId: params.docId || null,
        fileId: params.fileId || null,
        isRootDoc: params.isRootDoc || false,
        sizeBytes: params.sizeBytes || 0,
        hash: params.hash || null,
        sortOrder: params.sortOrder || 0,
      },
    });

    return this.mapToEntity(created);
  }

  public async findById(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.manuscriptNode.findFirst({
      where: {
        projectId,
        OR: [{ id: nodeId }, { docId: nodeId }, { fileId: nodeId }],
      },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async findByPath(
    projectId: string,
    path: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const normalized = NodePathVo.normalize(path);
    const raw = await this.prisma.manuscriptNode.findUnique({
      where: {
        projectId_path: {
          projectId,
          path: normalized,
        },
      },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async findByFileId(
    projectId: string,
    fileId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.manuscriptNode.findFirst({
      where: { projectId, fileId },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    const nodes = await this.prisma.manuscriptNode.findMany({
      where: { projectId },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return nodes.map((n) => this.mapToEntity(n));
  }

  public async getRootDoc(
    projectId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.manuscriptNode.findFirst({
      where: { projectId, isRootDoc: true },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    const targetNode = await this.prisma.manuscriptNode.findFirst({
      where: {
        projectId,
        OR: [{ id: nodeId }, { docId: nodeId }],
      },
    });

    if (!targetNode) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }

    await this.prisma.$transaction([
      this.prisma.manuscriptNode.updateMany({
        where: { projectId, isRootDoc: true },
        data: { isRootDoc: false },
      }),
      this.prisma.manuscriptNode.updateMany({
        where: { id: targetNode.id, projectId },
        data: { isRootDoc: true },
      }),
    ]);
  }

  public async unsetRootDoc(projectId: string): Promise<void> {
    await this.prisma.manuscriptNode.updateMany({
      where: { projectId, isRootDoc: true },
      data: { isRootDoc: false },
    });
  }

  public async moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null,
  ): Promise<void> {
    const normSource = NodePathVo.normalize(sourcePath);
    const normDest = NodePathVo.normalize(destPath);
    const sourcePrefix = normSource + '/';

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const movedRoot = await tx.manuscriptNode.update({
        where: {
          projectId_path: {
            projectId,
            path: normSource,
          },
        },
        data: {
          path: normDest,
          name: NodePathVo.basename(normDest),
          parentId: newParentId,
          depth: NodePathVo.depth(normDest),
        },
      });

      await this.syncBackingAssetPath(tx, projectId, movedRoot, normDest);

      const descendants = await tx.manuscriptNode.findMany({
        where: {
          projectId,
          path: { startsWith: sourcePrefix },
        },
      });

      await Promise.all(
        descendants.map(async (descendant) => {
          const rebased = NodePathVo.rebase(
            descendant.path,
            normSource,
            normDest,
          );

          await tx.manuscriptNode.update({
            where: { id: descendant.id },
            data: {
              path: rebased.path,
              depth: rebased.depth,
            },
          });

          await this.syncBackingAssetPath(tx, projectId, descendant, rebased.path);
        }),
      );
    });
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string,
  ): Promise<ManuscriptNodeEntity> {
    const depth = NodePathVo.depth(newPath);
    const result = await this.prisma.manuscriptNode.updateMany({
      where: { id: nodeId, projectId },
      data: {
        name: newName,
        path: newPath,
        depth,
      },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
    const updated = await this.prisma.manuscriptNode.findFirst({
      where: { id: nodeId, projectId },
    });
    await this.syncBackingAssetPath(this.prisma, projectId, updated, newPath);
    return this.mapToEntity(updated!);
  }

  public async deleteSubtree(
    projectId: string,
    path: string,
  ): Promise<ManuscriptNodeEntity[]> {
    const normalized = NodePathVo.normalize(path);
    const prefix = normalized + '/';

    const targets = await this.prisma.manuscriptNode.findMany({
      where: {
        projectId,
        OR: [{ path: normalized }, { path: { startsWith: prefix } }],
      },
    });

    const targetIds = targets.map((t) => t.id);
    const docIds = Array.from(
      new Set(
        targets
          .map((t) => t.docId)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );
    const fileIds = Array.from(
      new Set(
        targets
          .map((t) => t.fileId)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );

    const now = new Date();
    const runCleanup = async (
      db: Pick<
        PrismaService,
        'manuscriptNode' | 'manuscriptDoc' | 'manuscriptFile'
      >,
    ) => {
      const ops: Promise<unknown>[] = [];
      if (targetIds.length > 0) {
        ops.push(
          db.manuscriptNode.deleteMany({
            where: { id: { in: targetIds }, projectId },
          }),
        );
      }

      if (docIds.length > 0 && db.manuscriptDoc?.updateMany) {
        ops.push(
          db.manuscriptDoc.updateMany({
            where: { id: { in: docIds }, projectId, deleted: false },
            data: { deleted: true, deletedAt: now },
          }),
        );
      }

      if (fileIds.length > 0 && db.manuscriptFile?.updateMany) {
        ops.push(
          db.manuscriptFile.updateMany({
            where: { id: { in: fileIds }, projectId, deleted: false },
            data: { deleted: true, deletedAt: now },
          }),
        );
      }

      if (ops.length > 0) {
        await Promise.all(ops);
      }
    };

    if (
      targetIds.length > 0 ||
      (docIds.length > 0 && typeof this.prisma.manuscriptDoc?.updateMany === 'function') ||
      (fileIds.length > 0 && typeof this.prisma.manuscriptFile?.updateMany === 'function')
    ) {
      if (typeof this.prisma.$transaction === 'function') {
        await this.prisma.$transaction(async (tx) => {
          const client = tx?.manuscriptNode ? tx : this.prisma;
          await runCleanup(client);
        });
      } else {
        await runCleanup(this.prisma);
      }
    }

    return targets.map((t) => this.mapToEntity(t));
  }

  public async updateSortOrder(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void> {
    const result = await this.prisma.manuscriptNode.updateMany({
      where: { id: nodeId, projectId },
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
  ): Promise<ManuscriptNodeEntity> {
    const result = await this.prisma.manuscriptNode.updateMany({
      where: { id: nodeId, projectId },
      data: {
        fileId,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(hash !== undefined ? { hash } : {}),
      },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
    const updated = await this.prisma.manuscriptNode.findFirst({
      where: { id: nodeId, projectId },
    });
    return this.mapToEntity(updated!);
  }

  public async countNodes(projectId: string): Promise<number> {
    return await this.prisma.manuscriptNode.count({
      where: { projectId },
    });
  }

  public async docExistsInProject(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    const doc = await this.prisma.manuscriptDoc.findFirst({
      where: { id: docId, projectId, deleted: false },
      select: { id: true },
    });
    return Boolean(doc);
  }

  public async fileExistsInProject(
    projectId: string,
    fileId: string,
  ): Promise<boolean> {
    const file = await this.prisma.manuscriptFile.findFirst({
      where: { id: fileId, projectId, deleted: false },
      select: { id: true },
    });
    return Boolean(file);
  }
}
