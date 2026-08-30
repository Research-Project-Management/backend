import { Injectable, Logger } from '@nestjs/common';
import { CatalogService } from '../../catalog/catalog.service';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { CreateCatalogItemData } from '../../catalog/catalog.repository';

export interface CommitStageOptions {
  collectionIds?: string[];
  tagIds?: string[];
  userId?: string;
  source?: 'doi' | 'bibtex' | 'ris' | 'url' | 'pdf' | 'manual';
}

@Injectable()
export class CommitStage {
  private readonly logger = new Logger(CommitStage.name);

  constructor(private readonly catalogService: CatalogService) {}

  /**
   * Executes canonical Catalog commit for a reconciled item proposal.
   */
  async execute(
    workspaceId: string,
    metadata: ItemMetadata,
    options?: CommitStageOptions,
  ): Promise<any> {
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
      labels: metadata.tags,
      collectionId: options?.collectionIds?.[0] || null,
      uploadedById: options?.userId || 'system',
    };

    return this.catalogService.createItem(workspaceId, createData, {
      source: (options?.source as any) || 'manual',
    });
  }
}
