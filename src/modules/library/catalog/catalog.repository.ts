import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { VersionMismatchException } from '../common/library-mutation.dto';

export interface CreateCatalogItemData {
  title: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  fileUrl?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  collectionId?: string;
  uploadedById: string;
}

export interface UpdateCatalogItemData {
  title?: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  collectionId?: string | null;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        attachments: {
          include: { revisions: true },
        },
      },
    });
  }

  async findMany(
    workspaceId: string,
    options: {
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const limit = Math.min(options.limit ?? 50, 100);
    const where: any = {
      workspaceId,
      deletedAt: null,
    };

    if (options.collectionId) {
      where.OR = [
        { collectionId: options.collectionId },
        { collectionItems: { some: { collectionId: options.collectionId } } },
      ];
    }

    if (options.tagId) {
      where.itemTags = { some: { tagId: options.tagId } };
    }

    if (options.search) {
      where.OR = [
        { title: { contains: options.search, mode: 'insensitive' } },
        { abstract: { contains: options.search, mode: 'insensitive' } },
        { doi: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    return client.catalogItem.findMany({
      where,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        attachments: true,
      },
    });
  }

  async create(
    workspaceId: string,
    data: CreateCatalogItemData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.create({
      data: {
        workspaceId,
        title: data.title,
        authors: data.authors ?? [],
        year: data.year ?? null,
        doi: data.doi ?? '',
        abstract: data.abstract ?? '',
        itemType: data.itemType ?? 'journalArticle',
        journal: data.journal ?? '',
        publisher: data.publisher ?? '',
        volume: data.volume ?? '',
        issue: data.issue ?? '',
        pages: data.pages ?? '',
        url: data.url ?? '',
        fileUrl: data.fileUrl ?? '',
        filename: data.filename ?? data.title,
        mimeType: data.mimeType ?? 'application/pdf',
        size: data.size ?? 0,
        collectionId: data.collectionId ?? null,
        uploadedById: data.uploadedById,
        version: 1,
        ...(data.collectionId
          ? {
              collectionItems: {
                create: {
                  collectionId: data.collectionId,
                  sortOrder: 0,
                },
              },
            }
          : {}),
      },
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
      },
    });
  }

  async update(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateCatalogItemData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const existing = await client.catalogItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${workspaceId}`,
      );
    }

    if (existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'CatalogItem',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    return client.catalogItem.update({
      where: { id },
      data: {
        title: data.title ?? existing.title,
        authors: data.authors ?? existing.authors,
        year: data.year !== undefined ? data.year : existing.year,
        doi: data.doi ?? existing.doi,
        abstract: data.abstract ?? existing.abstract,
        itemType: data.itemType ?? existing.itemType,
        journal: data.journal ?? existing.journal,
        publisher: data.publisher ?? existing.publisher,
        volume: data.volume ?? existing.volume,
        issue: data.issue ?? existing.issue,
        pages: data.pages ?? existing.pages,
        url: data.url ?? existing.url,
        collectionId:
          data.collectionId !== undefined
            ? data.collectionId
            : existing.collectionId,
        version: { increment: 1 },
      },
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
      },
    });
  }

  async softDelete(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    if (expectedVersion !== undefined) {
      const existing = await client.catalogItem.findFirst({
        where: { id, workspaceId, deletedAt: null },
      });
      if (existing && existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
    }

    const result = await client.catalogItem.updateMany({
      where: { id, workspaceId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }
}
