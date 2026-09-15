import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  IStorageNodeRepository,
  ListDriveFilter,
} from '../../domain/ports/storage-node.repository.port';
import { StorageNode } from '../../domain/entities/storage-node.entity';
import { StorageNodeMapper } from './mappers/storage-node.mapper';
import { FileScope } from '../../domain/value-objects/file-scope.vo';

@Injectable()
export class PrismaStorageNodeRepository implements IStorageNodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<StorageNode | null> {
    const record = await this.prisma.file.findUnique({
      where: { id },
    });
    return record ? StorageNodeMapper.toDomain(record) : null;
  }

  async create(node: StorageNode): Promise<StorageNode> {
    const data = StorageNodeMapper.toPrismaCreate(node);
    const created = await this.prisma.file.create({ data });
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
    const where: any = {};
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

    if (filter.scope) {
      where.linkedToType = filter.scope;
      if (filter.projectId) {
        where.linkedToId = filter.projectId;
      }
    } else {
      // Default: Exclude Library and Paper files from Personal Drive
      where.NOT = [
        { linkedToType: { in: [FileScope.Library, FileScope.Paper] } },
        { metaData: { path: ['source'], equals: 'library' } },
        { metaData: { path: ['source'], equals: 'paper' } },
      ];
    }

    const [records, total] = await Promise.all([
      this.prisma.file.findMany({
        where,
        orderBy: [{ isFolder: 'desc' }, { filename: 'asc' }],
        take: filter.limit ?? 100,
        skip: filter.offset ?? 0,
      }),
      this.prisma.file.count({ where }),
    ]);

    return {
      nodes: records.map(StorageNodeMapper.toDomain),
      total,
    };
  }

  async findByBlobId(blobId: string): Promise<StorageNode[]> {
    const records = await this.prisma.file.findMany({
      where: { blobId },
    });
    return records.map(StorageNodeMapper.toDomain);
  }

  async softDeleteSubtree(rootNodeId: string): Promise<number> {
    // Recursive soft-delete via CTE (ltree-compatible)
    const now = new Date();
    const result = await this.prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id FROM files WHERE id = ${rootNodeId}::uuid
        UNION ALL
        SELECT f.id FROM files f JOIN subtree s ON f.parent_id = s.id
      )
      UPDATE files SET trashed_at = ${now}
      WHERE id IN (SELECT id FROM subtree) AND trashed_at IS NULL;
    `;
    return Number(result);
  }

  async restoreSubtree(rootNodeId: string): Promise<number> {
    const result = await this.prisma.$executeRaw`
      WITH RECURSIVE subtree AS (
        SELECT id FROM files WHERE id = ${rootNodeId}::uuid
        UNION ALL
        SELECT f.id FROM files f JOIN subtree s ON f.parent_id = s.id
      )
      UPDATE files SET trashed_at = NULL
      WHERE id IN (SELECT id FROM subtree);
    `;
    return Number(result);
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
    return records.map(StorageNodeMapper.toDomain);
  }
}
