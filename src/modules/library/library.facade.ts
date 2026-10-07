import { Injectable, Optional } from '@nestjs/common';
import { CatalogFacade } from './catalog/catalog.facade';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ExtractionFacade } from './extraction/extraction.facade';
import { CslJsonMapper } from './citation';
import { TransactionService } from './sync';
import { LibraryChange, Tombstone } from '@prisma/client';

import { ExtractedPdfDocument } from './extraction';

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

export interface ILibraryFacade {
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
  ): Promise<LibraryChange[]>;
  getSyncTombstones(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit?: number,
  ): Promise<Tombstone[]>;
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

  get catalog(): CatalogFacade {
    return this.catalogFacade!;
  }

  get extraction(): ExtractionFacade {
    return this.extractionFacade!;
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
    // Scatter-gather across Bounded Contexts (Microservices-Ready)
    const [catalogItem, attachmentsRes, notes] = await Promise.all([
      this.catalogFacade.getItem(userId, itemId, projectId),
      this.extractionFacade.getItemAttachments(userId, itemId),
      this.catalogFacade.listNotes(userId, itemId, projectId),
    ]);

    if (!catalogItem) return null;

    const rawAttachments = Array.isArray(attachmentsRes)
      ? attachmentsRes
      : attachmentsRes?.attachments || [];

    const attachments: AttachmentSummaryDto[] = rawAttachments.map(
      (a: any) => ({
        id: a.id,
        filename: a.filename || a.title || 'untitled',
        mimeType: a.mimeType || 'application/octet-stream',
        size: a.size !== undefined ? a.size : null,
        url: a.url || (a.fileId ? `/api/files/${a.fileId}/content` : null),
        linkMode: a.linkMode || 'imported_file',
        attachmentType: a.attachmentType || null,
      }),
    );

    const rawNotes = Array.isArray(notes) ? notes : [];
    const noteSummaries: NoteSummaryDto[] = rawNotes.map((n: any) => ({
      id: n.id,
      title: n.title || null,
      content: n.content || n.contentMd || null,
      contentMd: n.contentMd || n.content || null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }));

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
        .map((it) => ({
          id: it.tag?.id || it.tagId,
          name: it.tag?.name || it.name || '',
          color: it.tag?.color || null,
        }))
        .filter((t: any): t is TagSummaryDto => Boolean(t.name));
    } else if (Array.isArray(extItem.tags)) {
      tags = extItem.tags
        .map((t) =>
          typeof t === 'string'
            ? { name: t }
            : { id: t.id, name: t.name || t.tag || '', color: t.color || null },
        )
        .filter((t: any): t is TagSummaryDto => Boolean(t.name));
    }

    let collections: CollectionSummaryDto[] = [];
    if (Array.isArray(extItem.collectionItems)) {
      collections = extItem.collectionItems
        .filter((ci) => Boolean(ci.collection?.id || ci.collectionId))
        .map((ci) => ({
          id: (ci.collection?.id || ci.collectionId) as string,
          name: ci.collection?.name || '',
          color: ci.collection?.color || null,
          parentId: ci.collection?.parentId || null,
        }));
    } else if (Array.isArray(extItem.collections)) {
      collections = extItem.collections
        .filter((c) => Boolean(c.id))
        .map((c) => ({
          id: c.id as string,
          name: c.name || '',
          color: c.color || null,
          parentId: c.parentId || null,
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
    const items = await this.catalogFacade.findMany(userId, {
      search: query,
      limit: 20,
      ...(projectId ? { projectId } : {}),
    });

    return items.map((it: any) => ({
      id: it.id,
      title: it.title,
      doi: it.doi,
      abstract: it.abstract,
      year: it.year,
      itemType: it.itemType || 'journalArticle',
      authors: CslJsonMapper.getAuthorNames(it),
    }));
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument> {
    return this.extractionFacade.extractDocumentFromBuffer(buffer, options);
  }

  async getSyncVersion(
    scope: { userId?: string; projectId?: string } | string,
  ): Promise<bigint> {
    return this.transactionService.getLatestSequence(scope);
  }

  async getSyncChanges(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq: bigint = BigInt(0),
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    return this.transactionService.getChangesSince(scope, sinceSeq, limit);
  }

  async getSyncTombstones(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    return this.transactionService.getTombstonesSince(scope, sinceSeq, limit);
  }
}
