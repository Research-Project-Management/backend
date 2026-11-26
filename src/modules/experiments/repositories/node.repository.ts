import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { FileNode as PrismaFile, Prisma } from '@prisma/client';
import { isValidUuid } from '@/modules/files/domain/files.policy';
import { ListExperimentsFilter, SharedNodeItem } from '../experiments.type';
import {
  FileScope,
  normalizeFileScope,
  ExperimentNode,
} from '../domain/node.domain';
import {
  applyFileTypeFilter,
  FILE_AUTHOR_SELECT,
  NodeMapper,
  parseFileOrderBy,
} from '../domain/experiments.mapper';

export type { ListExperimentsFilter, SharedNodeItem };

@Injectable()
export class NodeRepository {
  private readonly logger = new Logger(NodeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, userId?: string): Promise<ExperimentNode | null> {
    const record = await this.prisma.fileNode.findUnique({
      where: { id },
      include: {
        createdBy: { select: FILE_AUTHOR_SELECT },
        stars: userId
          ? { where: { userId }, select: { userId: true } }
          : { select: { userId: true }, take: 1 },
      },
    });
    return record ? NodeMapper.toDomain(record) : null;
  }

  async create(node: ExperimentNode): Promise<ExperimentNode> {
    const data = NodeMapper.toPrismaCreate(node);
    const created = await this.prisma.fileNode.create({
      data,
      include: {
        createdBy: { select: FILE_AUTHOR_SELECT },
        stars: { where: { userId: node.authorId }, select: { userId: true } },
      },
    });
    if (node.starred && isValidUuid(node.authorId)) {
      await this.setStarred(node.id, node.authorId, true);
      created.stars = [{ userId: node.authorId }];
    }
    return NodeMapper.toDomain(created);
  }

  async setStarred(
    fileId: string,
    userId: string,
    starred: boolean,
  ): Promise<boolean> {
    if (!isValidUuid(fileId) || !isValidUuid(userId)) return starred;
    if (starred) {
      await this.prisma.fileStar.upsert({
        where: {
          fileId_userId: { fileId, userId },
        },
        create: { fileId, userId },
        update: {},
      });
    } else {
      await this.prisma.fileStar.deleteMany({
        where: { fileId, userId },
      });
    }
    return starred;
  }

  async update(node: ExperimentNode, userId?: string): Promise<ExperimentNode> {
    const data = NodeMapper.toPrismaCreate(node);
    const targetStarUserId = userId || node.authorId;
    if (isValidUuid(node.id) && isValidUuid(targetStarUserId)) {
      await this.setStarred(node.id, targetStarUserId, node.starred);
    }

    const updated = await this.prisma.fileNode.update({
      where: { id: node.id },
      data: {
        spaceId: data.spaceId,
        filename: data.filename,
        size: data.size,
        mimeType: data.mimeType,
        parentId: data.parentId,
        linkedToType: data.linkedToType,
        linkedToId: data.linkedToId,
        metadata: data.metadata,
        blobId: data.blobId,
        deletedAt: data.deletedAt,
        updatedAt: data.updatedAt,
      },
      include: {
        createdBy: { select: FILE_AUTHOR_SELECT },
        stars: isValidUuid(targetStarUserId)
          ? { where: { userId: targetStarUserId }, select: { userId: true } }
          : { select: { userId: true }, take: 1 },
      },
    });
    return NodeMapper.toDomain(updated);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.fileNode.delete({
      where: { id },
    });
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.fileNode.deleteMany({
      where: { id: { in: ids } },
    });
  }

  async list(
    filter: ListExperimentsFilter,
  ): Promise<{ nodes: ExperimentNode[]; total: number }> {
    const targetUserId = filter.userId ?? filter.authorId;
    const where: Prisma.FileNodeWhereInput = {};
    const andConditions: Prisma.FileNodeWhereInput[] = [];

    if (filter.projectId) {
      where.spaceId = filter.projectId;
    } else if (targetUserId && !filter.linkedToId) {
      where.spaceId = targetUserId;
    }

    if (filter.authorId) {
      where.createdById = filter.authorId;
    } else if (targetUserId && !filter.projectId && !filter.linkedToId) {
      where.createdById = targetUserId;
    }

    if (filter.trashedOnly) {
      where.deletedAt = { not: null };
      if (filter.parentId === undefined && !filter.search?.trim()) {
        andConditions.push({
          OR: [{ parentId: null }, { parent: { deletedAt: null } }],
        });
      }
    } else {
      where.deletedAt = null;
    }

    if (filter.parentId !== undefined) {
      where.parentId = filter.parentId;
    }

    if (filter.starredOnly) {
      if (targetUserId && isValidUuid(targetUserId)) {
        where.stars = { some: { userId: targetUserId } };
      } else {
        where.stars = { some: {} };
      }
    }

    if (filter.search && filter.search.trim()) {
      where.filename = { contains: filter.search.trim(), mode: 'insensitive' };
    }

    applyFileTypeFilter(where, filter.types);

    if (filter.scope) {
      const normalizedScope = normalizeFileScope(filter.scope);
      where.linkedToType = { equals: normalizedScope, mode: 'insensitive' };
      const targetLinkedId = filter.linkedToId ?? filter.projectId;
      if (targetLinkedId) {
        where.linkedToId = targetLinkedId;
      }
    } else if (filter.projectId) {
      where.linkedToType = { equals: FileScope.Project, mode: 'insensitive' };
      where.linkedToId = filter.projectId;
    } else {
      andConditions.push({
        OR: [
          { linkedToType: null },
          { linkedToType: { equals: FileScope.Personal, mode: 'insensitive' } },
          {
            linkedToType: {
              notIn: [FileScope.Project, 'project'],
            },
          },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = [
        ...(Array.isArray(where.AND)
          ? where.AND
          : where.AND
            ? [where.AND]
            : []),
        ...andConditions,
      ];
    }

    const orderBy = parseFileOrderBy(filter.sortBy, filter.sortOrder);

    const [records, total] = await Promise.all([
      this.prisma.fileNode.findMany({
        where,
        orderBy,
        take: filter.limit ?? 100,
        skip: filter.offset ?? 0,
        include: {
          createdBy: { select: FILE_AUTHOR_SELECT },
          stars:
            targetUserId && isValidUuid(targetUserId)
              ? { where: { userId: targetUserId }, select: { userId: true } }
              : { select: { userId: true }, take: 1 },
        },
      }),
      this.prisma.fileNode.count({ where }),
    ]);

    return {
      nodes: records.map((r) => NodeMapper.toDomain(r)),
      total,
    };
  }

  async softDeleteSubtree(rootNodeId: string): Promise<number> {
    if (!isValidUuid(rootNodeId)) return 0;
    const now = new Date();
    const result = await this.prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id, 0 as depth FROM file_nodes WHERE id = ${rootNodeId}::uuid
        UNION ALL
        SELECT f.id, s.depth + 1 FROM file_nodes f JOIN subtree s ON f.parent_id = s.id
        WHERE s.depth < 50
      )
      UPDATE file_nodes SET deleted_at = ${now}
      WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL;
    `;
    return Number(result);
  }

  async restoreSubtree(rootNodeId: string): Promise<number> {
    if (!isValidUuid(rootNodeId)) return 0;
    const result = await this.prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id, 0 as depth FROM file_nodes WHERE id = ${rootNodeId}::uuid
        UNION ALL
        SELECT f.id, s.depth + 1 FROM file_nodes f JOIN subtree s ON f.parent_id = s.id
        WHERE s.depth < 50
      )
      UPDATE file_nodes SET deleted_at = NULL
      WHERE id IN (SELECT id FROM subtree);
    `;
    return Number(result);
  }

  async findSubtreeNodes(rootNodeId: string): Promise<ExperimentNode[]> {
    if (!isValidUuid(rootNodeId)) return [];
    try {
      const records = await this.prisma.$queryRaw<PrismaFile[]>`
        WITH RECURSIVE subtree AS (
          SELECT id, 0 as depth FROM file_nodes WHERE id = ${rootNodeId}::uuid
          UNION ALL
          SELECT f.id, s.depth + 1 FROM file_nodes f JOIN subtree s ON f.parent_id = s.id
          WHERE s.depth < 50
        )
        SELECT f.* FROM file_nodes f JOIN subtree s ON f.id = s.id;
      `;
      return records.map((r) => NodeMapper.toDomain(r));
    } catch (err: unknown) {
      this.logger.warn(`Recursive query failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  async findExpiredTrash(
    daysOld: number,
    limit: number,
  ): Promise<ExperimentNode[]> {
    const threshold = new Date(Date.now() - daysOld * 24 * 3600 * 1000);
    const records = await this.prisma.fileNode.findMany({
      where: {
        deletedAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map((r) => NodeMapper.toDomain(r));
  }

  async isDescendant(
    rootNodeId: string,
    candidateId: string,
  ): Promise<boolean> {
    if (!isValidUuid(rootNodeId) || !isValidUuid(candidateId)) return false;
    try {
      const result = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, 0 as depth FROM file_nodes WHERE id = ${candidateId}::uuid
          UNION ALL
          SELECT f.id, f.parent_id, a.depth + 1 FROM file_nodes f JOIN ancestors a ON f.id = a.parent_id
          WHERE a.id <> ${rootNodeId}::uuid AND a.depth < 50
        )
        SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ${rootNodeId}::uuid) AS "exists";
      `;
      return Boolean(result[0]?.exists);
    } catch (err: unknown) {
      this.logger.warn(`Cycle check query failed: ${(err as Error)?.message}`);
      return false;
    }
  }

  async getFolderPath(
    folderId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    if (!isValidUuid(folderId)) return [];
    try {
      const records = await this.prisma.$queryRaw<
        Array<{ id: string; filename: string; depth: number }>
      >`
        WITH RECURSIVE breadcrumbs AS (
          SELECT id, filename, parent_id, 0 as depth FROM file_nodes WHERE id = ${folderId}::uuid
          UNION ALL
          SELECT f.id, f.filename, f.parent_id, b.depth + 1
          FROM file_nodes f JOIN breadcrumbs b ON f.id = b.parent_id
          WHERE b.depth < 50
        )
        SELECT id, filename, depth FROM breadcrumbs ORDER BY depth DESC;
      `;
      return records.map((r) => ({ id: r.id, name: r.filename }));
    } catch (err: unknown) {
      this.logger.warn(`Recursive query failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  async listSharedWithUser(
    userId: string,
    take: number,
    skip: number,
    filter?: {
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      types?: string[];
    },
  ): Promise<{ items: SharedNodeItem[]; total: number }> {
    const fileWhere: Prisma.FileNodeWhereInput = { deletedAt: null };
    if (filter?.search && filter.search.trim()) {
      fileWhere.filename = {
        contains: filter.search.trim(),
        mode: 'insensitive',
      };
    }
    applyFileTypeFilter(fileWhere, filter?.types);

    const where: Prisma.FileShareWhereInput = {
      userId,
      file: fileWhere,
    };

    const [shares, total] = await Promise.all([
      this.prisma.fileShare.findMany({
        where,
        include: {
          file: {
            include: {
              createdBy: { select: FILE_AUTHOR_SELECT },
              stars: isValidUuid(userId)
                ? { where: { userId }, select: { userId: true } }
                : { select: { userId: true }, take: 1 },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.fileShare.count({ where }),
    ]);

    const items = shares
      .filter((s) => s.file)
      .map((s) => ({
        node: NodeMapper.toDomain(s.file),
        permission: s.permission,
        sharedAt: s.createdAt,
      }));

    return { items, total };
  }

  async shareNode(
    fileId: string,
    targetUserId: string,
    permissionType: 'view' | 'edit' = 'view',
  ): Promise<{
    id: string;
    fileId: string;
    userId: string;
    permission: string;
    createdAt: string;
  }> {
    const permission =
      permissionType === 'edit' ? ('edit' as const) : ('view' as const);

    const share = await this.prisma.fileShare.upsert({
      where: {
        fileId_userId: {
          fileId,
          userId: targetUserId,
        },
      },
      update: { permission },
      create: {
        fileId,
        userId: targetUserId,
        permission,
      },
    });

    return {
      id: `${share.fileId}:${share.userId}`,
      fileId: share.fileId,
      userId: share.userId,
      permission: share.permission,
      createdAt: share.createdAt.toISOString(),
    };
  }

  async findUserSharesForFiles(
    fileIds: string[],
    userId: string,
  ): Promise<Array<{ permission: string }>> {
    return this.prisma.fileShare.findMany({
      where: { fileId: { in: fileIds }, userId },
      select: { permission: true },
    });
  }

  async findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return membership?.role ? String(membership.role) : null;
  }

  async findSpaceOwnerId(spaceId: string): Promise<string | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { ownerUserId: true },
    });
    return space?.ownerUserId ?? null;
  }
}
