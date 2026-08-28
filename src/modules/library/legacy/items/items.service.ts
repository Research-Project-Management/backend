import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ItemsRepository } from './items.repository';
import { Prisma, AttachmentType, RagStatus } from '@prisma/client';
import { toLibraryItemListResult, toLibraryItemResponse } from './items.mapper';
import { LibraryItemListQuery, LibraryItemRecord } from './types/items.types';

import {
  IngestCatalogItemDto,
  UploadCatalogItemDto,
  AddAttachmentDto,
  UpdateCatalogItemDto,
  ImportStorageCatalogItemDto,
} from './dto/items.dto';

import { FileService } from '@/modules/storage/file/file.service';
import {
  extractYearFromDate,
  normalizeCreators,
  normalizeLibraryItemType,
  normalizeTags,
} from '../metadata/types/metadata.types';

@Injectable()
export class ItemsService {
  private static readonly DEFAULT_LIST_LIMIT = 50;
  private static readonly MAX_LIST_LIMIT = 100;

  constructor(
    private readonly catalogRepo: ItemsRepository,
    private readonly fileService: FileService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /**
   * Get workspace library catalog items with search, collection, and smart virtual filters
   */
  async getPapers(workspaceId: string, query?: LibraryItemListQuery) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const where = this.buildWhereClause(targetWsId, query);
    const limit = this.clampListLimit(query?.limit);
    const skip = Math.max(Number(query?.skip ?? 0), 0);

    const [papers, total] = await Promise.all([
      this.catalogRepo.findItems(where, {
        orderBy: [{ createdAt: 'desc' }],
        take: limit,
        skip,
      }),
      this.catalogRepo.countItems(where),
    ]);

    return toLibraryItemListResult(papers, total, { limit, skip });
  }

  private clampListLimit(limit?: number): number {
    const parsed = Number(limit ?? ItemsService.DEFAULT_LIST_LIMIT);
    if (!Number.isFinite(parsed)) return ItemsService.DEFAULT_LIST_LIMIT;
    return Math.min(Math.max(parsed, 1), ItemsService.MAX_LIST_LIMIT);
  }

  async getItems(workspaceId: string, query?: LibraryItemListQuery) {
    return this.getPapers(workspaceId, query);
  }

  async getPaperById(itemId: string) {
    const paper = await this.catalogRepo.findItemById(itemId);
    if (!paper || paper.deletedAt) {
      throw new NotFoundException('Catalog item not found');
    }
    return toLibraryItemResponse(paper);
  }

  async getItemById(itemId: string) {
    return this.getPaperById(itemId);
  }

  async getItemByIdInWorkspace(workspaceId: string, itemId: string) {
    const item = await this.resolveItemInWorkspace(workspaceId, itemId);
    return toLibraryItemResponse(item);
  }

  /**
   * Upload research paper PDF and create library item
   */
  async uploadPaper(
    workspaceId: string,
    userId: string,
    dto: UploadCatalogItemDto,
  ) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const authors = dto.authors?.length
      ? dto.authors
      : dto.author
        ? [dto.author]
        : [];
    const year = dto.year || (dto.date ? extractYearFromDate(dto.date) : null);
    const itemType = normalizeLibraryItemType(dto.itemType || dto.type);

    const baseKey =
      dto.citationKey?.trim() ||
      `${authors[0]?.split(' ').pop()?.toLowerCase() || 'item'}${year || 'nd'}`;
    const citationKey = await this.catalogRepo.resolveUniqueCitationKey(
      targetWsId,
      baseKey,
    );

    const paper = await this.catalogRepo.createItem({
      workspace: { connect: { id: targetWsId } },
      uploadedBy: { connect: { id: userId } },
      title: dto.title,
      filename: dto.filename ?? '',
      fileUrl: dto.fileUrl ?? '',
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/pdf',
      authors,
      editors: dto.editors || [],
      year,

      doi: dto.doi?.trim() || null,
      abstract: dto.abstract || dto.abstractNote || null,
      journal: dto.journal || null,
      publisher: dto.publisher || null,
      publicationTitle: dto.publicationTitle || dto.journal || dto.publisher || null,
      place: dto.place || null,
      volume: dto.volume || null,
      issue: dto.issue || null,
      section: dto.section || null,
      partNumber: dto.partNumber || null,
      partTitle: dto.partTitle || null,
      pages: dto.pages || null,
      series: dto.series || null,
      seriesTitle: dto.seriesTitle || null,
      seriesText: dto.seriesText || null,
      issn: dto.issn || null,
      isbn: dto.isbn || null,
      pmid: dto.pmid || null,
      pmcid: dto.pmcid || null,
      url: dto.url || null,
      type: dto.type || null,
      language: dto.language || null,
      journalAbbr: dto.journalAbbr || null,
      shortTitle: dto.shortTitle || null,
      rights: dto.rights || null,
      license: dto.license || null,
      libraryCatalog: dto.libraryCatalog || null,
      archive: dto.archive || null,
      archiveLocation: dto.archiveLocation || null,
      callNumber: dto.callNumber || null,
      extra: dto.extra || null,
      itemType,
      publicationDate: dto.publicationDate || dto.date || null,
      accessedAt: dto.accessDate
        ? new Date(dto.accessDate)
        : dto.accessedAt
          ? new Date(dto.accessedAt)
          : null,
      citationKey,
      labels: normalizeTags(dto.tags || dto.keywords || []),
      ...(dto.collectionId && {
        collection: { connect: { id: dto.collectionId } },
      }),
    });

    return toLibraryItemResponse(paper);
  }

  /**
   * Ingest research paper into workspace library
   */
  async ingestPaper(
    workspaceId: string,
    userId: string,
    dto: IngestCatalogItemDto,
  ) {
    return this.uploadPaper(workspaceId, userId, dto as any);
  }

  /**
   * Import document from Storage service
   */
  async importFromStorage(
    workspaceId: string,
    userId: string,
    dto: ImportStorageCatalogItemDto,
  ) {
    const fileResult = await this.fileService.getFile(dto.fileId, userId);
    const file = fileResult?.file;

    if (!file) {
      throw new NotFoundException('Storage file not found');
    }

    return this.uploadPaper(workspaceId, userId, {
      ...dto,
      title: dto.title || file.filename.replace(/\.[^/.]+$/, ''),
      filename: file.filename,
      fileUrl: file.url || '',
      size: file.size || 0,
      mimeType: file.mimeType || 'application/pdf',
    });
  }

  /**
   * Update catalog item fields cleanly without manual undefined branching boilerplate
   */
  async updateItem(itemId: string, dto: UpdateCatalogItemDto) {
    return this.updateResolvedItem(itemId, dto);
  }

  async updateItemInWorkspace(
    workspaceId: string,
    itemId: string,
    dto: UpdateCatalogItemDto,
  ) {
    const item = await this.resolveItemInWorkspace(workspaceId, itemId);
    return this.updateResolvedItem(item.id, dto);
  }

  private async updateResolvedItem(itemId: string, dto: UpdateCatalogItemDto) {
    const updateData: Prisma.CatalogItemUpdateInput = {};
    const assignableUpdateData = updateData as Record<string, unknown>;
    const entries = Object.entries(dto) as Array<
      [
        keyof UpdateCatalogItemDto,
        UpdateCatalogItemDto[keyof UpdateCatalogItemDto],
      ]
    >;

    const PRISMA_VALID_COLUMNS = new Set([
      'title',
      'authors',
      'year',
      'doi',
      'abstract',
      'itemType',
      'editors',
      'journal',
      'publicationTitle',
      'publicationDate',
      'publisher',
      'place',
      'volume',
      'issue',
      'section',
      'partNumber',
      'partTitle',
      'pages',
      'series',
      'seriesTitle',
      'seriesText',
      'issn',
      'isbn',
      'pmid',
      'pmcid',
      'url',
      'type',
      'language',
      'journalAbbr',
      'shortTitle',
      'rights',
      'license',
      'citationKey',
      'libraryCatalog',
      'archive',
      'archiveLocation',
      'callNumber',
      'accessedAt',
      'extra',
      'notes',
      'labels',
      'keywords',
    ]);

    const customFields: Record<string, any> = {};

    for (const [key, value] of entries) {
      if (value === undefined) continue;

      if (key === 'collectionId') {
        updateData.collection = value
          ? {
              connect: {
                id: value as string,
              },
            }
          : { disconnect: true };
      } else if (key === 'creators') {
        const rawCreators = normalizeCreators(value as any[]);
        const authors = rawCreators
          .filter((c) => c.creatorType === 'author' || !c.creatorType)
          .map(
            (c) =>
              c.name ||
              [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
          )
          .filter(Boolean);
        const editors = rawCreators
          .filter((c) => c.creatorType === 'editor')
          .map(
            (c) =>
              c.name ||
              [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
          )
          .filter(Boolean);
        if (authors.length > 0) {
          updateData.authors = authors;
        }
        if (editors.length > 0) {
          updateData.editors = editors;
        }
      } else if (key === 'tags') {
        updateData.labels = normalizeTags(value as string[]);
      } else if (key === 'abstractNote') {
        updateData.abstract = typeof value === 'string' ? value : '';
      } else if (key === 'date') {
        const dateStr = typeof value === 'string' ? value : '';
        updateData.publicationDate = dateStr;
        const parsedYear = extractYearFromDate(dateStr);
        if (parsedYear && dto.year === undefined) {
          updateData.year = parsedYear;
        }
      } else if (key === 'accessDate') {
        const date =
          value instanceof Date
            ? value
            : new Date(typeof value === 'string' ? value : '');
        if (!Number.isNaN(date.getTime())) {
          updateData.accessedAt = date;
        }
      } else if (key === 'itemType') {
        updateData.itemType = normalizeLibraryItemType(
          typeof value === 'string' ? value : '',
        );
      } else if (key === 'bookTitle' || key === 'proceedingsTitle' || key === 'websiteTitle') {
        if (!dto.publicationTitle) {
          updateData.publicationTitle = String(value);
        }
        customFields[key] = value;
      } else if (key === 'university' || key === 'institution') {
        if (!dto.publisher) {
          updateData.publisher = String(value);
        }
        customFields[key] = value;
      } else if (key === 'thesisType' || key === 'reportType' || key === 'genre' || key === 'websiteType') {
        if (!dto.type) {
          updateData.type = String(value);
        }
        customFields[key] = value;
      } else if (key === 'country') {
        if (!dto.place) {
          updateData.place = String(value);
        }
        customFields[key] = value;
      } else if (PRISMA_VALID_COLUMNS.has(String(key))) {
        assignableUpdateData[String(key)] = value;
      } else {
        customFields[String(key)] = value;
      }
    }

    // Merge custom fields into extra if present
    if (Object.keys(customFields).length > 0) {
      let baseExtra: Record<string, any> = {};
      const currentExtra = (typeof updateData.extra === 'string' ? updateData.extra : (dto.extra || ''));
      if (currentExtra && currentExtra.trim().startsWith('{') && currentExtra.trim().endsWith('}')) {
        try {
          baseExtra = JSON.parse(currentExtra.trim());
        } catch {
          // keep as is
        }
      }
      updateData.extra = JSON.stringify({ ...baseExtra, ...customFields });
    }

    const paper = await this.catalogRepo.updateItem(itemId, updateData);

    this.eventEmitter?.emit('paper.updated', {
      entityType: 'paper',
      entityId: paper.id,
      verb: 'updated',
      workspaceId: paper.workspaceId,
    });

    return toLibraryItemResponse(paper);
  }

  async deleteItem(itemId: string) {
    const paper = await this.catalogRepo.findItemById(itemId);
    await this.catalogRepo.updateItem(itemId, { deletedAt: new Date() });

    this.eventEmitter?.emit('paper.deleted', {
      entityType: 'paper',
      entityId: itemId,
      verb: 'deleted',
      workspaceId: paper?.workspaceId,
    });

    return { message: 'Catalog item deleted successfully' };
  }

  async deleteItemInWorkspace(workspaceId: string, itemId: string) {
    const item = await this.resolveItemInWorkspace(workspaceId, itemId);
    await this.catalogRepo.updateItem(item.id, { deletedAt: new Date() });

    this.eventEmitter?.emit('paper.deleted', {
      entityType: 'paper',
      entityId: item.id,
      verb: 'deleted',
      workspaceId: item.workspaceId,
    });

    return { message: 'Catalog item deleted successfully' };
  }

  async restoreItemInWorkspace(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );
    if (!item) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }
    await this.catalogRepo.updateItem(item.id, { deletedAt: null });

    this.eventEmitter?.emit('paper.restored', {
      entityType: 'paper',
      entityId: item.id,
      verb: 'restored',
      workspaceId: item.workspaceId,
    });

    return { message: 'Catalog item restored successfully' };
  }

  async purgeItemInWorkspace(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );
    if (!item) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }
    await this.catalogRepo.purgeItemInWorkspace(targetWsId, item.id);

    this.eventEmitter?.emit('paper.purged', {
      entityType: 'paper',
      entityId: item.id,
      verb: 'purged',
      workspaceId: item.workspaceId,
    });

    return { message: 'Catalog item permanently purged' };
  }

  async restorePaper(itemId: string) {
    const paper = await this.catalogRepo.findItemById(itemId);
    await this.catalogRepo.updateItem(itemId, { deletedAt: null });

    this.eventEmitter?.emit('paper.restored', {
      entityType: 'paper',
      entityId: itemId,
      verb: 'restored',
      workspaceId: paper?.workspaceId,
    });

    return { message: 'Catalog item restored successfully' };
  }

  async restoreItem(itemId: string) {
    return this.restorePaper(itemId);
  }

  async addAttachment(itemId: string, dto: AddAttachmentDto) {
    const attachment = await this.catalogRepo.createAttachment({
      catalogItemId: itemId,
      filename: dto.filename,
      url: dto.url,
      fileId: dto.fileId || null,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/octet-stream',
      attachmentType: dto.attachmentType || AttachmentType.supplementary,
    });

    return {
      message: 'Attachment added successfully',
      attachment,
    };
  }

  async addAttachmentInWorkspace(
    workspaceId: string,
    itemId: string,
    dto: AddAttachmentDto,
  ) {
    const item = await this.resolveItemInWorkspace(workspaceId, itemId);
    return this.addAttachment(item.id, dto);
  }

  async removeAttachment(itemId: string, attachmentId: string) {
    await this.catalogRepo.deleteAttachment(attachmentId);
    return { message: 'Attachment removed successfully' };
  }

  async removeAttachmentInWorkspace(
    workspaceId: string,
    itemId: string,
    attachmentId: string,
  ) {
    const item = await this.resolveItemInWorkspace(workspaceId, itemId);
    const result = await this.catalogRepo.deleteAttachmentForItem(
      item.id,
      attachmentId,
    );

    if (result.count === 0) {
      throw new NotFoundException('Attachment not found for this catalog item');
    }

    return { message: 'Attachment removed successfully' };
  }

  async triggerReindex(itemId: string, _userId: string) {
    const paper = await this.catalogRepo.findItemById(itemId);
    await this.catalogRepo.updateItem(itemId, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });

    this.eventEmitter?.emit('paper.reindex_requested', {
      entityType: 'paper',
      entityId: itemId,
      verb: 'reindex_requested',
      workspaceId: paper?.workspaceId,
    });

    return { message: 'RAG indexing queued' };
  }

  async triggerReindexInWorkspace(
    workspaceId: string,
    itemId: string,
    _userId: string,
  ) {
    const item = await this.resolveItemInWorkspace(workspaceId, itemId);
    await this.catalogRepo.updateItem(item.id, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });

    this.eventEmitter?.emit('paper.reindex_requested', {
      entityType: 'paper',
      entityId: item.id,
      verb: 'reindex_requested',
      workspaceId: item.workspaceId,
    });

    return { message: 'RAG indexing queued' };
  }

  async getWorkspaceTags(workspaceId: string): Promise<string[]> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    return this.catalogRepo.findDistinctLabels(targetWsId);
  }

  // ─── Private Query Builders ──────────────────────────────────────────────

  private buildWhereClause(
    workspaceId: string,
    query?: LibraryItemListQuery,
  ): Prisma.CatalogItemWhereInput {
    const andFilters: Prisma.CatalogItemWhereInput[] = [];
    const isTrash = query?.smartFilter === 'trash';

    if (query?.smartFilter && !isTrash) {
      const smart = this.buildSmartFilter(query.smartFilter);
      if (smart) andFilters.push(smart);
    }

    if (query?.search?.trim()) {
      const s = query.search.trim();
      andFilters.push({
        OR: [
          { title: { contains: s, mode: 'insensitive' } },
          { doi: { contains: s, mode: 'insensitive' } },
          { abstract: { contains: s, mode: 'insensitive' } },
          { journal: { contains: s, mode: 'insensitive' } },
          { publisher: { contains: s, mode: 'insensitive' } },
          { citationKey: { contains: s, mode: 'insensitive' } },
          { authors: { has: s } },
          { labels: { has: s } },
        ],
      });
    }

    return {
      workspaceId,
      deletedAt: isTrash ? { not: null } : null,
      ...(query?.collectionId && { collectionId: query.collectionId }),
      ...(andFilters.length > 0 && { AND: andFilters }),
    };
  }

  private buildSmartFilter(
    smartFilter: string,
  ): Prisma.CatalogItemWhereInput | null {
    switch (smartFilter) {
      case 'unfiled':
        return { collectionId: null };
      case 'missing-doi':
        return { OR: [{ doi: null }, { doi: '' }] };
      case 'missing-pdf':
        return {
          attachments: {
            none: { mimeType: { contains: 'pdf', mode: 'insensitive' } },
          },
        };
      case 'with-notes':
        return { NOT: { notes: { equals: [] } } };
      case 'trash':
        return { deletedAt: { not: null } };
      default:
        return null;
    }
  }

  private async resolveItemInWorkspace(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );

    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    return item;
  }
}

export { ItemsService as CatalogService };
