import { Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { VersionMismatchException } from '../../../shared-kernel/core/errors/version-mismatch.exception';
import {
  ICollectionRepositoryPort,
  CollectionDto,
  CreateCollectionData,
  UpdateCollectionData,
} from '../../domain/ports/collection-repository.port';

/**
 * Infrastructure Adapter — implements ICollectionRepositoryPort using Prisma.
 *
 * This is an OUTBOUND / DRIVEN adapter (right-side hexagon).
 * The Application layer never imports this class — it depends only on the
 * ICollectionRepositoryPort interface (Dependency Inversion).
 */
@Injectable()
export class PrismaCollectionRepositoryAdapter implements ICollectionRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(raw: any): CollectionDto {
    return {
      id: raw.id,
      userId: raw.userId,
      projectId: raw.projectId,
      name: raw.name,
      description: raw.description,
      color: raw.color,
      icon: raw.icon,
      parentId: raw.parentId,
      version: raw.version,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      deletedAt: raw.deletedAt,
      children: raw.children?.map((c: any) => this.toDto(c)),
      _count: raw._count,
    };
  }

  async findById(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<CollectionDto | null> {
    const where =
      projectId && projectId !== 'user'
        ? { id: collectionId, projectId, deletedAt: null }
        : { id: collectionId, userId, deletedAt: null };

    const raw = await this.prisma.collection.findFirst({
      where,
      include: {
        children: { where: { deletedAt: null } },
        _count: { select: { collectionItems: true } },
      },
    });

    return raw ? this.toDto(raw) : null;
  }

  async findAll(userId: string, projectId?: string): Promise<CollectionDto[]> {
    const effectiveProjectId =
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal' &&
      isUUID(projectId)
        ? projectId
        : undefined;

    const where = effectiveProjectId
      ? { projectId: effectiveProjectId, deletedAt: null }
      : { userId, deletedAt: null };

    const rows = await this.prisma.collection.findMany({
      where,
      include: { _count: { select: { collectionItems: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((r) => this.toDto(r));
  }

  async create(data: CreateCollectionData): Promise<CollectionDto> {
    const effectiveProjectId =
      data.projectId && data.projectId !== 'user' ? data.projectId : null;

    const raw = await this.prisma.collection.create({
      data: {
        userId: data.userId,
        projectId: effectiveProjectId,
        name: data.name,
        description: data.description ?? '',
        color: data.color ?? '#3370ff',
        icon: data.icon ?? '',
        parentId: data.parentId ?? null,
        createdById: data.userId,
        version: 1,
      },
    });

    return this.toDto(raw);
  }

  async update(
    userId: string,
    collectionId: string,
    data: UpdateCollectionData,
    projectId?: string,
  ): Promise<CollectionDto> {
    const existing = await this.findById(userId, collectionId, projectId);
    if (!existing) {
      throw new NotFoundException(`Collection ${collectionId} not found`);
    }

    if (data.version !== undefined && existing.version !== data.version) {
      throw new VersionMismatchException({
        aggregateType: 'Collection',
        entityId: collectionId,
        currentVersion: existing.version,
        providedVersion: data.version,
      });
    }

    const raw = await this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.icon !== undefined ? { icon: data.icon } : {}),
        ...(data.parentId !== undefined ? { parentId: data.parentId } : {}),
        version: { increment: 1 },
      },
    });

    return this.toDto(raw);
  }

  async softDelete(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<void> {
    const scopeWhere =
      projectId && projectId !== 'user' ? { projectId } : { userId };

    // Orphan child collections
    await this.prisma.collection.updateMany({
      where: { ...scopeWhere, parentId: collectionId, deletedAt: null },
      data: { parentId: null },
    });

    await this.prisma.collection.updateMany({
      where: { id: collectionId, ...scopeWhere, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async addItems(collectionId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.prisma.collectionItem.createMany({
      data: itemIds.map((itemId) => ({ collectionId, itemId, sortOrder: 0 })),
      skipDuplicates: true,
    });
  }

  async removeItems(collectionId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.prisma.collectionItem.deleteMany({
      where: { collectionId, itemId: { in: itemIds } },
    });
  }
}
