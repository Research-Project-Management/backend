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
} from './domain';

@Injectable()
export class StructureRepository extends IStructureRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
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
        OR: [{ id: nodeId }, { docId: nodeId }],
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
      await tx.manuscriptNode.update({
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

      const descendants = await tx.manuscriptNode.findMany({
        where: {
          projectId,
          path: { startsWith: sourcePrefix },
        },
      });

      for (const descendant of descendants) {
        const relative = descendant.path.substring(normSource.length);
        const newChildPath = normDest + relative;
        const newDepth = NodePathVo.depth(newChildPath);

        await tx.manuscriptNode.update({
          where: { id: descendant.id },
          data: {
            path: newChildPath,
            depth: newDepth,
          },
        });
      }
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

    if (targetIds.length > 0) {
      await this.prisma.manuscriptNode.deleteMany({
        where: { id: { in: targetIds }, projectId },
      });
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
}
