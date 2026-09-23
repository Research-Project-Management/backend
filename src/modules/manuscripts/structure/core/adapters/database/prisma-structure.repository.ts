/**
 * modules/manuscripts/structure/core/adapters/database/prisma-structure.repository.ts
 * PostgreSQL Prisma implementation of IStructureRepository with atomic subtree move & rename.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IStructureRepository, CreateNodeParams } from '../../ports/structure-repository.port';
import { ManuscriptNodeEntity, ManuscriptNodeType } from '../../domain/manuscript-node.entity';
import { NodePathVo } from '../../domain/node-path.vo';

@Injectable()
export class PrismaStructureRepository implements IStructureRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapToEntity(raw: any): ManuscriptNodeEntity {
    return new ManuscriptNodeEntity({
      id: raw.id,
      projectId: raw.projectId,
      parentId: raw.parentId,
      type: raw.type as ManuscriptNodeType,
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

  public async createNode(params: CreateNodeParams): Promise<ManuscriptNodeEntity> {
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

  public async findById(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.manuscriptNode.findFirst({
      where: { id: nodeId, projectId },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async findByPath(projectId: string, path: string): Promise<ManuscriptNodeEntity | null> {
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
    return nodes.map((n: any) => this.mapToEntity(n));
  }

  public async getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.manuscriptNode.findFirst({
      where: { projectId, isRootDoc: true },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    await this.prisma.$transaction([
      // Unset previous root docs
      this.prisma.manuscriptNode.updateMany({
        where: { projectId, isRootDoc: true },
        data: { isRootDoc: false },
      }),
      // Set new root doc
      this.prisma.manuscriptNode.update({
        where: { id: nodeId },
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
    newParentId: string | null
  ): Promise<void> {
    const normSource = NodePathVo.normalize(sourcePath);
    const normDest = NodePathVo.normalize(destPath);
    const sourcePrefix = normSource + '/';

    await this.prisma.$transaction(async (tx: any) => {
      // 1. Update the moving node itself
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

      // 2. Query and update all descendants
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
    newPath: string
  ): Promise<ManuscriptNodeEntity> {
    const depth = NodePathVo.depth(newPath);
    const updated = await this.prisma.manuscriptNode.update({
      where: { id: nodeId },
      data: {
        name: newName,
        path: newPath,
        depth,
      },
    });
    return this.mapToEntity(updated);
  }

  public async deleteSubtree(projectId: string, path: string): Promise<ManuscriptNodeEntity[]> {
    const normalized = NodePathVo.normalize(path);
    const prefix = normalized + '/';

    // Find all nodes in subtree (including the node itself)
    const targets = await this.prisma.manuscriptNode.findMany({
      where: {
        projectId,
        OR: [{ path: normalized }, { path: { startsWith: prefix } }],
      },
    });

    const targetIds = targets.map((t: any) => t.id);

    if (targetIds.length > 0) {
      await this.prisma.manuscriptNode.deleteMany({
        where: { id: { in: targetIds } },
      });
    }

    return targets.map((t: any) => this.mapToEntity(t));
  }

  public async updateSortOrder(
    projectId: string,
    nodeId: string,
    sortOrder: number
  ): Promise<void> {
    await this.prisma.manuscriptNode.update({
      where: { id: nodeId },
      data: { sortOrder },
    });
  }
}
