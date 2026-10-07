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
    const noteSummaries: NoteSummaryDto[] = rawNotes.map((note) => {
      const untypedNote = note as {
        content?: string | null;
        contentMd?: string | null;
      };
      return {
        id: note.id,
        title: note.title || null,
        content: untypedNote.content || note.contentMd || null,
        contentMd: note.contentMd || untypedNote.content || null,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
    });

    interface ExtendedCatalogRelations {
      itemTags?: Array<{
        tag?: { id?: string; name?: string; color?: string | null };
        tagId?: string;
        name?: string;
        color?: string | null;
      }>;
      tags?: Array<
        | string
        | { id?: string; name?: string; tag?: string; color?: string | null }
      >;
      collectionItems?: Array<{
        collection?: {
          id?: string;
          name?: string;
          color?: string | null;
          parentId?: string | null;
        };
        collectionId?: string;
      }>;
      collections?: Array<{
        id?: string;
        name?: string;
        color?: string | null;
        parentId?: string | null;
      }>;
    }
    const extItem = catalogItem as ExtendedCatalogRelations;

    let tags: TagSummaryDto[] = [];
    if (Array.isArray(extItem.itemTags)) {
      tags = extItem.itemTags
        .map((itemTag) => ({
          id: itemTag.tag?.id || itemTag.tagId,
          name: itemTag.tag?.name || itemTag.name || '',
          color: itemTag.tag?.color || null,
        }))
        .filter((tagSummary: any): tagSummary is TagSummaryDto =>
          Boolean(tagSummary.name),
        );
    } else if (Array.isArray(extItem.tags)) {
      tags = extItem.tags
        .map((tagEntry) =>
          typeof tagEntry === 'string'
            ? { name: tagEntry }
            : {
                id: tagEntry.id,
                name: tagEntry.name || tagEntry.tag || '',
                color: tagEntry.color || null,
              },
        )
        .filter((tagSummary: any): tagSummary is TagSummaryDto =>
          Boolean(tagSummary.name),
        );
    }

    let collections: CollectionSummaryDto[] = [];
    if (Array.isArray(extItem.collectionItems)) {
      collections = extItem.collectionItems
        .filter((itemRef) =>
          Boolean(itemRef.collection?.id || itemRef.collectionId),
        )
        .map((itemRef) => ({
          id: (itemRef.collection?.id || itemRef.collectionId) as string,
          name: itemRef.collection?.name || '',
          color: itemRef.collection?.color || null,
          parentId: itemRef.collection?.parentId || null,
        }));
    } else if (Array.isArray(extItem.collections)) {
      collections = extItem.collections
        .filter((collection) => Boolean(collection.id))
        .map((collection) => ({
          id: collection.id as string,
          name: collection.name || '',
          color: collection.color || null,
          parentId: collection.parentId || null,
        }));
    }

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
