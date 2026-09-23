import { Injectable, Optional } from '@nestjs/common';
import {
  BibliographyFacade,
  CatalogFacade,
} from './bibliography/bibliography.facade';
import { SearchFacade } from './search/search.facade';
import { CitationFacade } from './citation/citation.facade';
import { ReaderFacade, ContentFacade } from './reader/reader.facade';
import { CslJsonMapper } from './citation/application/mappers/csl-json.mapper';
import { TransactionService } from './shared-kernel/outbox/transaction.service';
import { LibraryChange, Tombstone } from '@prisma/client';

import { ExtractedPdfDocument } from './reader/infrastructure/providers/pdf.provider';

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
    @Optional()
    private readonly bibliographyFacade?: BibliographyFacade,
    @Optional()
    private readonly readerFacade?: ReaderFacade,
    @Optional()
    private readonly searchFacade?: SearchFacade,
    @Optional()
    private readonly citationFacade?: CitationFacade,
    @Optional()
    private readonly transactionService?: TransactionService,
  ) {}

  get catalogFacade(): BibliographyFacade | undefined {
    return this.bibliographyFacade;
  }

  get contentFacade(): ReaderFacade | undefined {
    return this.readerFacade;
  }

  get search(): SearchFacade | undefined {
    return this.searchFacade;
  }

  get citation(): CitationFacade | undefined {
    return this.citationFacade;
  }

  async exportBibByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{ content: string } | null> {
    if (this.citationFacade) {
      return this.citationFacade.exportBibliography(
        userId,
        citeKeys,
        projectId,
      );
    }
    return null;
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
      this.contentFacade
        ? this.contentFacade.getItemAttachments(userId, itemId)
        : Promise.resolve({ attachments: [] }),
      this.contentFacade
        ? this.contentFacade.listNotes(userId, itemId, projectId)
        : Promise.resolve([]),
    ]);

    if (!catalogItem) return null;

    const rawAttachments = Array.isArray(attachmentsRes)
      ? attachmentsRes
      : attachmentsRes?.attachments || [];

    const attachments: AttachmentSummaryDto[] = rawAttachments.map((a: any) => ({
      id: a.id,
      filename: a.filename || a.title || 'untitled',
      mimeType: a.mimeType || 'application/octet-stream',
      size: a.size !== undefined ? a.size : null,
      url: a.url || (a.fileId ? `/api/files/${a.fileId}/content` : null),
      linkMode: a.linkMode || 'imported_file',
      attachmentType: a.attachmentType || null,
    }));

    const rawNotes = Array.isArray(notes) ? notes : [];
    const noteSummaries: NoteSummaryDto[] = rawNotes.map((n: any) => ({
      id: n.id,
      title: n.title || null,
      content: n.content || n.contentMd || null,
      contentMd: n.contentMd || n.content || null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }));

    let tags: TagSummaryDto[] = [];
    if (Array.isArray((catalogItem as any).itemTags)) {
      tags = (catalogItem as any).itemTags
        .map((it: any) => ({
          id: it.tag?.id || it.tagId,
          name: it.tag?.name || it.name || '',
          color: it.tag?.color || null,
        }))
        .filter((t: TagSummaryDto) => Boolean(t.name));
    } else if (Array.isArray((catalogItem as any).tags)) {
      tags = (catalogItem as any).tags
        .map((t: any) =>
          typeof t === 'string'
            ? { name: t }
            : { id: t.id, name: t.name || t.tag || '', color: t.color || null },
        )
        .filter((t: TagSummaryDto) => Boolean(t.name));
    }

    let collections: CollectionSummaryDto[] = [];
    if (Array.isArray((catalogItem as any).collectionItems)) {
      collections = (catalogItem as any).collectionItems
        .map((ci: any) => ({
          id: ci.collection?.id || ci.collectionId,
          name: ci.collection?.name || '',
          color: ci.collection?.color || null,
          parentId: ci.collection?.parentId || null,
        }))
        .filter((c: CollectionSummaryDto) => Boolean(c.id));
    } else if (Array.isArray((catalogItem as any).collections)) {
      collections = (catalogItem as any).collections
        .map((c: any) => ({
          id: c.id,
          name: c.name || '',
          color: c.color || null,
          parentId: c.parentId || null,
        }))
        .filter((c: CollectionSummaryDto) => Boolean(c.id));
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
    if (!this.contentFacade) {
      throw new Error('ContentFacade is not initialized in LibraryFacade');
    }
    return this.contentFacade.extractDocumentFromBuffer(buffer, options);
  }

  async getSyncVersion(
    scope: { userId?: string; projectId?: string } | string,
  ): Promise<bigint> {
    return this.transactionService?.getLatestSequence(scope) ?? BigInt(0);
  }

  async getSyncChanges(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq: bigint = BigInt(0),
    limit: number = 100,
  ): Promise<LibraryChange[]> {
    return (
      (await this.transactionService?.getChangesSince(scope, sinceSeq, limit)) ??
      []
    );
  }

  async getSyncTombstones(
    scope: { userId?: string; projectId?: string } | string,
    sinceSeq?: bigint,
    limit: number = 100,
  ): Promise<Tombstone[]> {
    return (
      (await this.transactionService?.getTombstonesSince(
        scope,
        sinceSeq,
        limit,
      )) ?? []
    );
  }
}
