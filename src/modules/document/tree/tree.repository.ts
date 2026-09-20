import { Injectable } from '@nestjs/common';
import { isUUID as isUuid } from 'class-validator';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Page } from '@prisma/client';
import { resolveCanonicalProjectId } from '../page/utils/page.utils';

export const TREE_NODE_SELECT = {
  id: true,
  title: true,
  slug: true,
  icon: true,
  rank: true,
  status: true,
  isLocked: true,
  parentPageId: true,
  mainFileId: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type TreeRecord = Prisma.PageGetPayload<{
  select: typeof TREE_NODE_SELECT;
}>;

export const NODE_TREE_SELECT = TREE_NODE_SELECT;
export type NodeTreeRecord = TreeRecord;

@Injectable()
export class TreeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveProjectId(projectId: string): Promise<string | null> {
    return resolveCanonicalProjectId(this.prisma, projectId);
  }

  async findProjectNodes(projectId: string): Promise<TreeRecord[]> {
    const canonicalId = await this.resolveProjectId(projectId);
    if (!canonicalId) return [];

    return this.prisma.page.findMany({
      where: {
        projectId: canonicalId,
        deletedAt: null,
      },
      select: TREE_NODE_SELECT,
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findNodeById(nodeId: string): Promise<Page | null> {
    if (!isUuid(nodeId)) return null;
    return this.prisma.page.findFirst({
      where: { id: nodeId, deletedAt: null },
    });
  }

  /**
   * PostgreSQL Recursive CTE: traverses the ancestor chain upwards from a node to the root.
   * Returns list of ancestor items with depth.
   */
  async findNodeAncestors(startNodeId: string): Promise<
    Array<{
      id: string;
      parentPageId: string | null;
      title: string;
      depth: number;
    }>
  > {
    if (!isUuid(startNodeId)) return [];

    try {
      if (typeof (this.prisma as any).$queryRaw === 'function') {
        const rows = await this.prisma.$queryRaw<
          Array<{
            id: string;
            parentPageId: string | null;
            title: string;
            depth: number;
          }>
        >`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_page_id AS "parentPageId", title, 1 AS depth
            FROM pages
            WHERE id = ${startNodeId}::uuid AND deleted_at IS NULL
            UNION ALL
            SELECT p.id, p.parent_page_id AS "parentPageId", p.title, a.depth + 1
            FROM pages p
            INNER JOIN ancestors a ON p.id = a."parentPageId"
            WHERE p.deleted_at IS NULL AND a.depth < 50
          )
          SELECT id, "parentPageId", title, depth FROM ancestors ORDER BY depth DESC;
        `;
        if (Array.isArray(rows) && rows.length > 0) {
          return rows;
        }
      }
    } catch {
      // Fallback to iterative lookup if table name casing differs or recursive query is unsupported
    }

    // Iterative fallback
    const result: Array<{
      id: string;
      parentPageId: string | null;
      title: string;
      depth: number;
    }> = [];
    const visited = new Set<string>();
    let currentId: string | null = startNodeId;
    let depth = 1;

    while (currentId && !visited.has(currentId) && depth <= 50) {
      visited.add(currentId);
      const row: {
        id: string;
        parentPageId: string | null;
        title: string;
        deletedAt: Date | null;
      } | null = await this.prisma.page.findUnique({
        where: { id: currentId },
        select: { id: true, parentPageId: true, title: true, deletedAt: true },
      });
      if (!row || row.deletedAt) break;
      result.unshift({
        id: row.id,
        parentPageId: row.parentPageId,
        title: row.title,
        depth: depth++,
      });
      currentId = row.parentPageId;
    }

    return result;
  }

  async findDirectChildren(parentNodeId: string): Promise<Page[]> {
    if (!isUuid(parentNodeId)) return [];
    return this.prisma.page.findMany({
      where: {
        parentPageId: parentNodeId,
        deletedAt: null,
      },
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async updateParentAndRank(
    nodeId: string,
    targetParentId: string | null,
    rank: number,
  ): Promise<Page> {
    return this.prisma.page.update({
      where: { id: nodeId },
      data: {
        parentPageId: targetParentId,
        rank,
        updatedAt: new Date(),
      },
    });
  }

  async setMainFile(nodeId: string, mainFileId: string): Promise<Page> {
    return this.prisma.page.update({
      where: { id: nodeId },
      data: {
        mainFileId,
        updatedAt: new Date(),
      },
    });
  }

  async createNode(data: Prisma.PageCreateInput): Promise<Page> {
    return this.prisma.page.create({
      data,
    });
  }
}
