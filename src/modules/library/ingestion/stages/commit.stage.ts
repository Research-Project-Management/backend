import { Injectable, Logger, Optional } from '@nestjs/common';
import { CatalogService } from '../../catalog/catalog.service';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { CreateCatalogItemData } from '../../catalog/catalog.repository';
import { LibraryItemSource } from '../../sync/events/library.events';

export interface CommitStageOptions {
  collectionIds?: string[];
  tagIds?: string[];
  userId?: string;
  source?: LibraryItemSource;
  fileId?: string;
  filename?: string;
}

@Injectable()
export class CommitStage {
  private readonly logger = new Logger(CommitStage.name);

  constructor(
    private readonly catalogService: CatalogService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Executes canonical Catalog commit for a reconciled item proposal.
   * Persists CatalogItem, child attachments, tags/keywords, and literature notes.
   */
  async execute(
    workspaceId: string,
    metadata: ItemMetadata,
    options?: CommitStageOptions,
  ): Promise<any> {
    const rawTags = metadata.tags || metadata.keywords || metadata.labels || [];

    const createData: CreateCatalogItemData = {
      title: metadata.title || 'Untitled Document',
      itemType: metadata.itemType || 'journalArticle',
      doi: metadata.doi,
      year: metadata.year ?? undefined,
      publicationTitle: metadata.publicationTitle,
      publisher: metadata.publisher,
      volume: metadata.volume,
      issue: metadata.issue,
      pages: metadata.pages,
      abstract: metadata.abstract,
      url: metadata.url,
      citationKey: metadata.citationKey,
      authors: metadata.authors,
      contributors: metadata.creators,
      labels: rawTags,
      keywords: rawTags,
      fileId: options?.fileId || metadata.fileId || undefined,
      filename: options?.filename || metadata.filename || undefined,
      fileUrl: metadata.fileUrl || metadata.pdfUrl || undefined,
      language: metadata.language || undefined,
      rights: metadata.rights || undefined,
      license: metadata.license || undefined,
      extra:
        typeof metadata.citationCount === 'number' &&
        (!metadata.extra || !/citations?:/i.test(metadata.extra))
          ? metadata.extra
            ? `${metadata.extra}\nCitations: ${metadata.citationCount}`
            : `Citations: ${metadata.citationCount}`
          : metadata.extra || undefined,
      extraFields: {
        ...(metadata.extraFields || {}),
        ...(typeof metadata.citationCount === 'number'
          ? { citationCount: metadata.citationCount }
          : {}),
        ...(typeof metadata.influentialCitationCount === 'number'
          ? { influentialCitationCount: metadata.influentialCitationCount }
          : {}),
      },
      libraryCatalog: metadata.libraryCatalog || undefined,
      callNumber: metadata.callNumber || undefined,
      archive: metadata.archive || undefined,
      collectionId: options?.collectionIds?.[0] || null,
      uploadedById: options?.userId || 'system',
    };

    const createdItem = await this.catalogService.createItem(
      workspaceId,
      createData,
      {
        source: (options?.source as any) || 'manual',
      },
    );

    // Persist child notes (e.g. Zotero notes, BibTeX annote/note, RIS N1)
    if (
      this.prisma &&
      createdItem?.id &&
      Array.isArray(metadata.notes) &&
      metadata.notes.length > 0
    ) {
      for (const note of metadata.notes) {
        const content =
          typeof note === 'string' ? note : (note as any)?.content;
        if (!content || !String(content).trim()) continue;
        const source =
          typeof note === 'object' ? (note as any)?.source : undefined;
        try {
          await this.prisma.note.create({
            data: {
              workspaceId,
              itemId: createdItem.id,
              title: source ? `Imported Note (${source})` : 'Imported Note',
              contentMd: String(content).trim(),
              contentJson: {
                type: 'doc',
                content: [{ type: 'paragraph', text: String(content).trim() }],
              },
              createdById: options?.userId || 'system',
              tags: ['imported', ...(source ? [source] : [])],
              version: 1,
            },
          });
        } catch (err: any) {
          this.logger.warn(
            `Failed to create imported note for item ${createdItem.id}: ${err.message}`,
          );
        }
      }
    }

    return createdItem;
  }
}
