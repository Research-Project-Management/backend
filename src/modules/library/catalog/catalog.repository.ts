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
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  type?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  extra?: string;
  notes?: any;
  labels?: string[];
  keywords?: string[];
  fileUrl?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  collectionId?: string | null;
  uploadedById: string;
}

export interface UpdateCatalogItemData {
  title?: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  type?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  extra?: string;
  notes?: any;
  labels?: string[];
  keywords?: string[];
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
    const limit = options.limit ?? 50;

    const where: Prisma.CatalogItemWhereInput = {
      workspaceId,
      deletedAt: null,
    };

    if (options.collectionId) {
      where.collectionItems = {
        some: { collectionId: options.collectionId },
      };
    }

    if (options.tagId) {
      where.itemTags = {
        some: { tagId: options.tagId },
      };
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
        editors: data.editors ?? [],
        journal: data.journal ?? '',
        publicationTitle: data.publicationTitle ?? data.journal ?? '',
        publicationDate: data.publicationDate ?? (data.year ? String(data.year) : ''),
        publisher: data.publisher ?? '',
        place: data.place ?? '',
        volume: data.volume ?? '',
        issue: data.issue ?? '',
        section: data.section ?? '',
        partNumber: data.partNumber ?? '',
        partTitle: data.partTitle ?? '',
        pages: data.pages ?? '',
        series: data.series ?? '',
        seriesTitle: data.seriesTitle ?? '',
        seriesText: data.seriesText ?? '',
        issn: data.issn ?? '',
        isbn: data.isbn ?? '',
        pmid: data.pmid ?? '',
        pmcid: data.pmcid ?? '',
        url: data.url ?? '',
        type: data.type ?? '',
        language: data.language ?? '',
        journalAbbr: data.journalAbbr ?? '',
        shortTitle: data.shortTitle ?? '',
        rights: data.rights ?? '',
        license: data.license ?? '',
        citationKey: data.citationKey ?? '',
        libraryCatalog: data.libraryCatalog ?? '',
        archive: data.archive ?? '',
        archiveLocation: data.archiveLocation ?? '',
        callNumber: data.callNumber ?? '',
        accessedAt: data.accessedAt ?? null,
        extra: data.extra ?? '',
        notes: data.notes ?? [],
        labels: data.labels ?? data.keywords ?? [],
        keywords: data.keywords ?? data.labels ?? [],
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
        editors: data.editors ?? existing.editors,
        journal: data.journal ?? existing.journal,
        publicationTitle: data.publicationTitle ?? existing.publicationTitle,
        publicationDate: data.publicationDate ?? existing.publicationDate,
        publisher: data.publisher ?? existing.publisher,
        place: data.place ?? existing.place,
        volume: data.volume ?? existing.volume,
        issue: data.issue ?? existing.issue,
        section: data.section ?? existing.section,
        partNumber: data.partNumber ?? existing.partNumber,
        partTitle: data.partTitle ?? existing.partTitle,
        pages: data.pages ?? existing.pages,
        series: data.series ?? existing.series,
        seriesTitle: data.seriesTitle ?? existing.seriesTitle,
        seriesText: data.seriesText ?? existing.seriesText,
        issn: data.issn ?? existing.issn,
        isbn: data.isbn ?? existing.isbn,
        pmid: data.pmid ?? existing.pmid,
        pmcid: data.pmcid ?? existing.pmcid,
        url: data.url ?? existing.url,
        type: data.type ?? existing.type,
        language: data.language ?? existing.language,
        journalAbbr: data.journalAbbr ?? existing.journalAbbr,
        shortTitle: data.shortTitle ?? existing.shortTitle,
        rights: data.rights ?? existing.rights,
        license: data.license ?? existing.license,
        citationKey: data.citationKey ?? existing.citationKey,
        libraryCatalog: data.libraryCatalog ?? existing.libraryCatalog,
        archive: data.archive ?? existing.archive,
        archiveLocation: data.archiveLocation ?? existing.archiveLocation,
        callNumber: data.callNumber ?? existing.callNumber,
        accessedAt: data.accessedAt !== undefined ? data.accessedAt : existing.accessedAt,
        extra: data.extra ?? existing.extra,
        notes: data.notes !== undefined ? data.notes : existing.notes,
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
