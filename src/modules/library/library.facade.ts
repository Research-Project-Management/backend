import { Injectable, Optional } from '@nestjs/common';
import { CatalogFacade } from './catalog/catalog.facade';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ExtractionFacade } from './extraction/extraction.facade';
import { CslJsonMapper } from './citation';
import { TransactionService } from './sync';
import { LibraryChange, Tombstone } from '@prisma/client';

import { ExtractedPdfDocument, AttachmentEntity } from './extraction';

export interface LibraryItemSummary {
  id: string;
  title: string;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  itemType: string;
  authors: string[];
}

export interface AttachmentSummaryDto {
  id: string;
  filename: string;
  mimeType: string;
  size?: number | bigint | null;
  url?: string | null;
  linkMode?: string | null;
  attachmentType?: string | null;
}

export interface NoteSummaryDto {
  id: string;
  title?: string | null;
  content?: string | null;
  contentMd?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface TagSummaryDto {
  id?: string;
  name: string;
  color?: string | null;
}

export interface CollectionSummaryDto {
  id: string;
  name: string;
  color?: string | null;
  parentId?: string | null;
}

export interface LibraryItemDetail extends LibraryItemSummary {
  attachments: AttachmentSummaryDto[];
  notes: NoteSummaryDto[];
  tags: TagSummaryDto[];
  collections: CollectionSummaryDto[];
}

export type SyncChangeDto = LibraryChange;
export type SyncTombstoneDto = Tombstone;

export interface ILibraryFacade {
  readonly catalog?: CatalogFacade;
  readonly extraction?: ExtractionFacade;
  readonly citation?: CitationFacade;
  readonly search?: SearchFacade;
  exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null>;
  getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemSummary | null>;
  getItemWithDetails(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemDetail | null>;
  countItems(userId: string, options?: { projectId?: string }): Promise<number>;
  searchItems(
    userId: string,
    query: string,
    projectId?: string,
  ): Promise<LibraryItemSummary[]>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument>;
  getSyncVersion(
    scope: { userId?: string; projectId?: string } | string,
  ): Promise<bigint>;
  getSyncChanges(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit?: number,
  ): Promise<SyncChangeDto[]>;
  getSyncTombstones(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit?: number,
  ): Promise<SyncTombstoneDto[]>;
}

export const LIBRARY_FACADE = 'LIBRARY_FACADE';

/**
 * Public Inter-Module Facade for Library Domain.
 * Serves as the single decoupled boundary for external modules (Document, LaTeX compiler, Search, AI).
 */
@Injectable()
export class LibraryFacade implements ILibraryFacade {
  constructor(
    @Optional() private readonly catalogFacade?: CatalogFacade,
    @Optional() private readonly extractionFacade?: ExtractionFacade,
    @Optional() private readonly searchFacade?: SearchFacade,
    @Optional() private readonly citationFacade?: CitationFacade,
    @Optional() private readonly transactionService?: TransactionService,
  ) {}

  get catalog(): CatalogFacade | undefined {
    return this.catalogFacade;
  }

  get extraction(): ExtractionFacade | undefined {
    return this.extractionFacade;
  }

  get citation(): CitationFacade | undefined {
    return this.citationFacade;
  }

  get search(): SearchFacade | undefined {
    return this.searchFacade;
  }

  async exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null> {
    if (!this.citationFacade) return null;
    return this.citationFacade.exportBibliography(userId, citeKeys, projectId);
  }

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemSummary | null> {
    if (!this.catalogFacade) return null;
    const item = await this.catalogFacade.getItem(userId, itemId, projectId);
    if (!item) return null;

    return {
      id: item.id,
      title: item.title,
      doi: item.doi,
      abstract: item.abstract,
      year: item.year,
      itemType: item.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(item),
    };
  }

  async getItemWithDetails(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<LibraryItemDetail | null> {
    if (!this.catalogFacade) return null;
    // Scatter-gather across Bounded Contexts (Microservices-Ready)
    const [catalogItem, attachmentsRes, notes] = await Promise.all([
      this.catalogFacade.getItem(userId, itemId, projectId),
      this.extractionFacade
        ? this.extractionFacade.getItemAttachments(userId, itemId)
        : Promise.resolve([]),
      this.catalogFacade.listNotes(userId, itemId, projectId),
    ]);

    if (!catalogItem) return null;

    const rawAttachments: AttachmentEntity[] = Array.isArray(attachmentsRes)
      ? attachmentsRes
      : [];

    const attachments: AttachmentSummaryDto[] = rawAttachments.map(
      (attachment) => ({
        id: attachment.id,
        filename: attachment.filename || 'untitled',
        mimeType: attachment.mimeType || 'application/octet-stream',
        size: attachment.size !== undefined ? attachment.size : null,
        url:
          attachment.url ||
          (attachment.fileId
            ? `/api/files/${attachment.fileId}/content`
            : null),
        linkMode: attachment.linkMode || 'imported_file',
        attachmentType: attachment.attachmentType || null,
      }),
    );

    const rawNotes = Array.isArray(notes) ? notes : [];
    const noteSummaries: NoteSummaryDto[] = rawNotes.map((note: any) => ({
      id: note.id,
      title: note.title || null,
      content: note.content || note.contentMd || null,
      contentMd: note.contentMd || note.content || null,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }));

    const tags = this.extractTagSummaries(catalogItem);
    const collections = this.extractCollectionSummaries(catalogItem);

    return {
      id: catalogItem.id,
      title: catalogItem.title,
      doi: catalogItem.doi,
      abstract: catalogItem.abstract,
      year: catalogItem.year,
      itemType: catalogItem.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(catalogItem),
      attachments,
      notes: noteSummaries,
      tags,
      collections,
    };
  }

  private extractTagSummaries(item: any): TagSummaryDto[] {
    if (!item) return [];
    if (Array.isArray(item.itemTags)) {
      return item.itemTags
        .map((it: any) => ({
          id: it.tag?.id || it.tagId,
          name: it.tag?.name || it.name || '',
          color: it.tag?.color || null,
        }))
        .filter((t: TagSummaryDto) => Boolean(t.name));
    }
    if (Array.isArray(item.tags)) {
      return item.tags
        .map((t: any) =>
          typeof t === 'string'
            ? { name: t }
            : {
                id: t.id,
                name: t.name || t.tag || '',
                color: t.color || null,
              },
        )
        .filter((t: TagSummaryDto) => Boolean(t.name));
    }
    return [];
  }

  private extractCollectionSummaries(item: any): CollectionSummaryDto[] {
    if (!item) return [];
    if (Array.isArray(item.collectionItems)) {
      return item.collectionItems
        .filter((ci: any) => Boolean(ci.collection?.id || ci.collectionId))
        .map((ci: any) => ({
          id: (ci.collection?.id || ci.collectionId) as string,
          name: ci.collection?.name || '',
          color: ci.collection?.color || null,
          parentId: ci.collection?.parentId || null,
        }));
    }
    if (Array.isArray(item.collections)) {
      return item.collections
        .filter((c: any) => Boolean(c.id))
        .map((c: any) => ({
          id: c.id as string,
          name: c.name || '',
          color: c.color || null,
          parentId: c.parentId || null,
        }));
    }
    return [];
  }

  async countItems(
    userId: string,
    options?: { projectId?: string },
  ): Promise<number> {
    if (!this.catalogFacade) return 0;
    return this.catalogFacade.countItems(userId, {
      view: 'all',
      ...(options?.projectId ? { projectId: options.projectId } : {}),
    });
  }

  async searchItems(
    userId: string,
    query: string,
    projectId?: string,
  ): Promise<LibraryItemSummary[]> {
    if (!this.catalogFacade) return [];
    const items = await this.catalogFacade.findMany(userId, {
      search: query,
      limit: 20,
      ...(projectId ? { projectId } : {}),
    });

    return items.map((catalogItem: any) => ({
      id: catalogItem.id,
      title: catalogItem.title,
      doi: catalogItem.doi,
      abstract: catalogItem.abstract,
      year: catalogItem.year,
      itemType: catalogItem.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(catalogItem),
    }));
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument> {
    if (!this.extractionFacade) {
      throw new Error('ExtractionFacade is not available');
    }
    return this.extractionFacade.extractDocumentFromBuffer(buffer, options);
  }

  async getSyncVersion(
    scope: { userId?: string; projectId?: string } | string,
  ): Promise<bigint> {
    if (!this.transactionService) return BigInt(0);
    return this.transactionService.getLatestSequence(scope);
  }

  async getSyncChanges(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq: bigint = BigInt(0),
    limit: number = 100,
  ): Promise<SyncChangeDto[]> {
    if (!this.transactionService) return [];
    return this.transactionService.getChangesSince(scope, sinceSeq, limit);
  }

  async getSyncTombstones(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit: number = 100,
  ): Promise<SyncTombstoneDto[]> {
    if (!this.transactionService) return [];
    return this.transactionService.getTombstonesSince(scope, sinceSeq, limit);
  }
}
