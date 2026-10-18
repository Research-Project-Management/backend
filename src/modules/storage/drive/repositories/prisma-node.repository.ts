import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { File as PrismaFile, Prisma } from '@prisma/client';
import { isValidUuid } from '@/modules/storage/core';
import { StorageNode, FileScope, ListDriveFilter } from '../types';

export type { ListDriveFilter };

export interface SharedNodeItem {
  node: StorageNode;
  permission: string;
  sharedAt: Date;
}

export interface IStorageNodeRepository {
  findById(id: string): Promise<StorageNode | null>;
  create(node: StorageNode): Promise<StorageNode>;
  update(node: StorageNode): Promise<StorageNode>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
  list(
    filter: ListDriveFilter,
  ): Promise<{ nodes: StorageNode[]; total: number }>;
  findByBlobId(blobId: string): Promise<StorageNode[]>;
  softDeleteSubtree(rootNodeId: string): Promise<number>;
  restoreSubtree(rootNodeId: string): Promise<number>;
  findSubtreeNodes(rootNodeId: string): Promise<StorageNode[]>;
  findExpiredTrash(daysOld: number, limit: number): Promise<StorageNode[]>;
  isDescendant(rootNodeId: string, candidateId: string): Promise<boolean>;
  getFolderPath(folderId: string): Promise<Array<{ id: string; name: string }>>;
  listSharedWithUser(
    userId: string,
    take: number,
    skip: number,
  ): Promise<{ items: SharedNodeItem[]; total: number }>;
  shareNode(
    fileId: string,
    targetUserId: string,
    permission: 'view' | 'edit',
  ): Promise<{
    id: string;
    fileId: string;
    userId: string;
    permission: string;
    createdAt: string;
  }>;
}

const FILE_AUTHOR_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

type PrismaFileWithAuthor = PrismaFile & {
  author?: {
    id: string;
    email: string | null;
    profile?: {
      name: string | null;
      avatar: string | null;
    } | null;
  } | null;
};

export class StorageNodeMapper {
  public static toDomain(record: PrismaFileWithAuthor): StorageNode {
    return new StorageNode({
      id: record.id,
      projectId: record.linkedToType === 'Project' ? record.linkedToId : null,
      parentId: record.parentId,
      name: record.filename,
      isFolder: record.isFolder,
      size: BigInt(record.size),
      mimeType: record.mimeType,
      blobId: record.blobId,
      scope: (record.linkedToType as FileScope) || FileScope.Personal,
      starred: record.starred,
      metadata: (record.metaData as Record<string, unknown>) || {},
      authorId: record.authorId,
      author: record.author
        ? {
            id: record.author.id,
            email: record.author.email,
            name: record.author.profile?.name ?? null,
            avatar: record.author.profile?.avatar ?? null,
          }
        : null,
      trashedAt: record.trashedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public static toPrismaCreate(node: StorageNode) {
    return {
      id: node.id,
      filename: node.name,
      size: node.size,
      mimeType: node.mimeType,
      isFolder: node.isFolder,
      starred: node.starred,
      metaData: node.metadata as Prisma.InputJsonValue,
      parentId: node.parentId,
      linkedToType: node.scope,
      linkedToId: node.projectId,
      blobId: node.blobId,
      authorId: node.authorId,
      trashedAt: node.trashedAt,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}

@Injectable()
export class PrismaStorageNodeRepository implements IStorageNodeRepository {
  private readonly logger = new Logger(PrismaStorageNodeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<StorageNode | null> {
    const record = await this.prisma.file.findUnique({
      where: { id },
      include: { author: { select: FILE_AUTHOR_SELECT } },
    });
    return record ? StorageNodeMapper.toDomain(record) : null;
  }

  async create(node: StorageNode): Promise<StorageNode> {
    const data = StorageNodeMapper.toPrismaCreate(node);
    const created = await this.prisma.file.create({
      data,
      include: { author: { select: FILE_AUTHOR_SELECT } },
    });
    return StorageNodeMapper.toDomain(created);
  }

  async update(node: StorageNode): Promise<StorageNode> {
    const data = StorageNodeMapper.toPrismaCreate(node);
    const updated = await this.prisma.file.update({
      where: { id: node.id },
      data: {
        filename: data.filename,
        size: data.size,
        mimeType: data.mimeType,
        parentId: data.parentId,
        starred: data.starred,
        metaData: data.metaData,
        blobId: data.blobId,
        trashedAt: data.trashedAt,
        updatedAt: data.updatedAt,
      },
      include: { author: { select: FILE_AUTHOR_SELECT } },
    });
    return StorageNodeMapper.toDomain(updated);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.file.delete({
      where: { id },
    });
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.file.deleteMany({
      where: { id: { in: ids } },
    });
  }

  async list(
    filter: ListDriveFilter,
  ): Promise<{ nodes: StorageNode[]; total: number }> {
    const targetUserId = filter.userId ?? filter.authorId;
    const where: Prisma.FileWhereInput = {};
    if (targetUserId) {
      where.authorId = targetUserId;
    }

    if (filter.trashedOnly) {
      where.trashedAt = { not: null };
    } else {
      where.trashedAt = null;
    }

    if (filter.parentId !== undefined) {
      where.parentId = filter.parentId;
    }

    if (filter.starredOnly) {
      where.starred = true;
    }

    if (filter.search && filter.search.trim()) {
      where.filename = { contains: filter.search.trim(), mode: 'insensitive' };
    }

    if (filter.types && filter.types.length > 0) {
      const typeConditions: Prisma.FileWhereInput[] = [];
      for (const rawType of filter.types) {
        const t = rawType.trim().toLowerCase();
        if (!t) continue;
        if (t === 'folder' || t === 'directory') {
          typeConditions.push({ isFolder: true });
        } else if (t === 'pdf') {
          typeConditions.push({
            isFolder: false,
            OR: [
              { mimeType: { contains: 'pdf', mode: 'insensitive' } },
              { filename: { endsWith: '.pdf', mode: 'insensitive' } },
            ],
          });
        } else if (t === 'image' || t === 'images') {
          typeConditions.push({
            isFolder: false,
            mimeType: { startsWith: 'image/', mode: 'insensitive' },
          });
        } else if (t === 'video' || t === 'videos') {
          typeConditions.push({
            isFolder: false,
            mimeType: { startsWith: 'video/', mode: 'insensitive' },
          });
        } else if (t === 'audio') {
          typeConditions.push({
            isFolder: false,
            mimeType: { startsWith: 'audio/', mode: 'insensitive' },
          });
        } else if (t === 'spreadsheet' || t === 'csv' || t === 'excel') {
          typeConditions.push({
            isFolder: false,
            OR: [
              { mimeType: { contains: 'spreadsheet', mode: 'insensitive' } },
              { mimeType: { contains: 'excel', mode: 'insensitive' } },
              { mimeType: { contains: 'csv', mode: 'insensitive' } },
              { filename: { endsWith: '.csv', mode: 'insensitive' } },
              { filename: { endsWith: '.xlsx', mode: 'insensitive' } },
              { filename: { endsWith: '.xls', mode: 'insensitive' } },
            ],
          });
        } else if (t === 'document' || t === 'doc' || t === 'text') {
          typeConditions.push({
            isFolder: false,
            OR: [
              { mimeType: { startsWith: 'text/', mode: 'insensitive' } },
              { mimeType: { contains: 'word', mode: 'insensitive' } },
              { mimeType: { contains: 'document', mode: 'insensitive' } },
              { mimeType: { contains: 'latex', mode: 'insensitive' } },
              { mimeType: { contains: 'tex', mode: 'insensitive' } },
            ],
          });
        } else if (t === 'archive' || t === 'zip') {
          typeConditions.push({
            isFolder: false,
            OR: [
              { mimeType: { contains: 'zip', mode: 'insensitive' } },
              { mimeType: { contains: 'tar', mode: 'insensitive' } },
              { mimeType: { contains: 'gzip', mode: 'insensitive' } },
              { mimeType: { contains: 'compressed', mode: 'insensitive' } },
            ],
          });
        } else {
          typeConditions.push({
            isFolder: false,
            OR: [
              { mimeType: { contains: t, mode: 'insensitive' } },
              {
                filename: {
                  endsWith: `.${t.replace(/^\./, '')}`,
                  mode: 'insensitive',
                },
              },
            ],
          });
        }
      }
      if (typeConditions.length === 1) {
        Object.assign(where, typeConditions[0]);
      } else if (typeConditions.length > 1) {
        where.AND = [
          ...(Array.isArray(where.AND)
            ? where.AND
            : where.AND
              ? [where.AND]
              : []),
          { OR: typeConditions },
        ];
      }
    }

    if (filter.scope) {
      where.linkedToType = filter.scope;
      if (filter.projectId) {
        where.linkedToId = filter.projectId;
      }
    } else {
      // Default: Exclude Library and Paper files from Personal Drive
      where.NOT = [
        { linkedToType: { in: [FileScope.Library, FileScope.Paper] } },
      ];
    }

    let orderBy: Prisma.FileOrderByWithRelationInput[] = [
      { isFolder: 'desc' },
      { filename: 'asc' },
    ];
    if (filter.sortBy) {
      const orderDir = filter.sortOrder === 'desc' ? 'desc' : 'asc';
      if (filter.sortBy === 'updatedAt' || filter.sortBy === 'updated_at') {
        orderBy = [{ isFolder: 'desc' }, { updatedAt: orderDir }];
      } else if (
        filter.sortBy === 'createdAt' ||
        filter.sortBy === 'created_at'
      ) {
        orderBy = [{ isFolder: 'desc' }, { createdAt: orderDir }];
      } else if (filter.sortBy === 'size') {
        orderBy = [{ isFolder: 'desc' }, { size: orderDir }];
      } else if (filter.sortBy === 'name' || filter.sortBy === 'filename') {
        orderBy = [{ isFolder: 'desc' }, { filename: orderDir }];
      }
    }

    const [records, total] = await Promise.all([
      this.prisma.file.findMany({
        where,
        orderBy,
        take: filter.limit ?? 100,
        skip: filter.offset ?? 0,
        include: { author: { select: FILE_AUTHOR_SELECT } },
      }),
      this.prisma.file.count({ where }),
    ]);

    return {
      nodes: records.map((r) => StorageNodeMapper.toDomain(r)),
      total,
    };
  }

  async findByBlobId(blobId: string): Promise<StorageNode[]> {
    const records = await this.prisma.file.findMany({
      where: { blobId },
      include: { author: { select: FILE_AUTHOR_SELECT } },
    });
    return records.map((r) => StorageNodeMapper.toDomain(r));
  }

  async softDeleteSubtree(rootNodeId: string): Promise<number> {
    if (!isValidUuid(rootNodeId)) return 0;
    const now = new Date();
    const result = await this.prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id, 0 as depth FROM files WHERE id = ${rootNodeId}::uuid
        UNION ALL
        SELECT f.id, s.depth + 1 FROM files f JOIN subtree s ON f.parent_id = s.id
        WHERE s.depth < 50
      )
      UPDATE files SET trashed_at = ${now}
      WHERE id IN (SELECT id FROM subtree) AND trashed_at IS NULL;
    `;
    return Number(result);
  }

  async restoreSubtree(rootNodeId: string): Promise<number> {
    if (!isValidUuid(rootNodeId)) return 0;
    const result = await this.prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id, 0 as depth FROM files WHERE id = ${rootNodeId}::uuid
        UNION ALL
        SELECT f.id, s.depth + 1 FROM files f JOIN subtree s ON f.parent_id = s.id
        WHERE s.depth < 50
      )
      UPDATE files SET trashed_at = NULL
      WHERE id IN (SELECT id FROM subtree);
    `;
    return Number(result);
  }

  async findSubtreeNodes(rootNodeId: string): Promise<StorageNode[]> {
    if (!isValidUuid(rootNodeId)) return [];
    try {
      const records = await this.prisma.$queryRaw<PrismaFile[]>`
        WITH RECURSIVE subtree AS (
          SELECT id, 0 as depth FROM files WHERE id = ${rootNodeId}::uuid
          UNION ALL
          SELECT f.id, s.depth + 1 FROM files f JOIN subtree s ON f.parent_id = s.id
          WHERE s.depth < 50
        )
        SELECT f.* FROM files f JOIN subtree s ON f.id = s.id;
      `;
      return records.map((r) => StorageNodeMapper.toDomain(r));
    } catch (err: unknown) {
      this.logger.warn(`Recursive query failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  async findExpiredTrash(
    daysOld: number,
    limit: number,
  ): Promise<StorageNode[]> {
    const threshold = new Date(Date.now() - daysOld * 24 * 3600 * 1000);
    const records = await this.prisma.file.findMany({
      where: {
        trashedAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map((r) => StorageNodeMapper.toDomain(r));
  }

  async isDescendant(
    rootNodeId: string,
    candidateId: string,
  ): Promise<boolean> {
    if (!isValidUuid(rootNodeId) || !isValidUuid(candidateId)) return false;
    try {
      const result = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, 0 as depth FROM files WHERE id = ${candidateId}::uuid
          UNION ALL
          SELECT f.id, f.parent_id, a.depth + 1 FROM files f JOIN ancestors a ON f.id = a.parent_id
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
          SELECT id, filename, parent_id, 0 as depth FROM files WHERE id = ${folderId}::uuid
          UNION ALL
          SELECT f.id, f.filename, f.parent_id, b.depth + 1
          FROM files f JOIN breadcrumbs b ON f.id = b.parent_id
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
  ): Promise<{
    items: Array<{
      node: StorageNode;
      permission: string;
      sharedAt: Date;
    }>;
    total: number;
  }> {
    const [shares, total] = await Promise.all([
      this.prisma.fileShare.findMany({
        where: {
          userId,
          file: { trashedAt: null },
        },
        include: {
          file: {
            include: { author: { select: FILE_AUTHOR_SELECT } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.fileShare.count({
        where: {
          userId,
          file: { trashedAt: null },
        },
      }),
    ]);

    const items = shares
      .filter((s) => s.file)
      .map((s) => ({
        node: StorageNodeMapper.toDomain(s.file),
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
      id: share.id,
      fileId: share.fileId,
      userId: share.userId,
      permission: share.permission,
      createdAt: share.createdAt.toISOString(),
    };
  }
}
