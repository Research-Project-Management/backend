import {
  Injectable,
  Logger,
  Optional,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  ItemDetail,
  CATALOG_FACADE,
  ICatalogFacade,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';
import {
  METADATA_PORT,
  MetadataPort,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import { buildReResolvePatch } from '@/modules/library/ingestion/domain/enrichment-patch.builder';

export interface ReResolveMetadataOptions {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  title?: string;
  forceRefresh?: boolean;
  aggressive?: boolean;
  fields?: string[];
  expectedVersion?: number;
}

export interface ReResolveMetadataResult {
  success: boolean;
  message: string;
  itemId: string;
  item: ItemDetail | null;
  resolvedFrom?: {
    query: string;
    queryType: string;
    canonicalId?: string;
  };
  updatedFields: string[];
  warnings?: string[];
}

@Injectable()
export class MetadataResolverService {
  private readonly logger = new Logger(MetadataResolverService.name);

  constructor(
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataService?: MetadataPort,
  ) {}

  /**
   * Re-resolves bibliographic metadata for an existing library item on demand.
   * Queries Open Academic Mirrors (CrossRef, arXiv, PubMed, EuropePMC) and harmonizes fields.
   */
  async reResolveMetadata(
    userId: string,
    itemId: string,
    options?: ReResolveMetadataOptions,
    projectId?: string,
  ): Promise<ReResolveMetadataResult> {
    if (!this.catalogGateway) {
      throw new BadRequestException(
        'Catalog gateway is unavailable for metadata re-resolution',
      );
    }

    const existingItem = await this.catalogGateway.getItem(
      userId,
      itemId,
      projectId,
    );
    if (!existingItem) {
      throw new NotFoundException(`Item "${itemId}" not found in library`);
    }

    // Determine query & queryType
    let query: string | undefined;
    let queryType: QueryType | undefined;

    if (options?.doi) {
      query = normalizeDoi(options.doi) || options.doi.trim();
      queryType = 'DOI';
    } else if (options?.arxivId) {
      query = normalizeArxivId(options.arxivId) || options.arxivId.trim();
      queryType = 'ARXIV';
    } else if (options?.pmid) {
      query = normalizePmid(options.pmid) || options.pmid.trim();
      queryType = 'PMID';
    } else if (options?.isbn) {
      query = normalizeIsbn(options.isbn) || options.isbn.trim();
      queryType = 'ISBN';
    } else if (options?.title) {
      query = options.title.trim();
      queryType = 'TITLE';
    } else if (existingItem.doi) {
      query = normalizeDoi(existingItem.doi) || existingItem.doi;
      queryType = 'DOI';
    } else if (existingItem.extraFields?.arxivId || existingItem.arxivId) {
      const candArxiv =
        existingItem.extraFields?.arxivId ?? existingItem.arxivId;
      const rawArxiv =
        typeof candArxiv === 'string' || typeof candArxiv === 'number'
          ? String(candArxiv)
          : '';
      query = normalizeArxivId(rawArxiv) || rawArxiv;
      queryType = 'ARXIV';
    } else if (existingItem.extraFields?.pmid || existingItem.pmid) {
      const candPmid = existingItem.extraFields?.pmid ?? existingItem.pmid;
      const rawPmid =
        typeof candPmid === 'string' || typeof candPmid === 'number'
          ? String(candPmid)
          : '';
      query = normalizePmid(rawPmid) || rawPmid;
      queryType = 'PMID';
    } else if (existingItem.isbn) {
      query = normalizeIsbn(existingItem.isbn) || existingItem.isbn;
      queryType = 'ISBN';
    } else if (
      existingItem.title &&
      existingItem.title.trim().length >= 10 &&
      !/^(untitled|document|uploaded document|manuscript)$/i.test(
        existingItem.title.trim(),
      )
    ) {
      query = existingItem.title.trim();
      queryType = 'TITLE';
    }

    if (!query) {
      throw new BadRequestException(
        'Cannot re-resolve metadata: item has no existing identifier or credible title. Please specify a DOI, arXiv ID, or title in request body.',
      );
    }

    if (!this.metadataService) {
      throw new BadRequestException(
        'MetadataService is unavailable for metadata re-resolution',
      );
    }

    const resolved = await this.metadataService.resolve({
      query,
      queryType,
      forceRefresh: options?.forceRefresh ?? options?.aggressive ?? true,
      scopeId: projectId || 'user',
    });

    if (!resolved || !resolved.metadata) {
      return {
        success: false,
        message: `No authoritative bibliographic metadata found for query "${query}".`,
        itemId,
        item: existingItem,
        updatedFields: [],
      };
    }

    const { updateData, updatedFields } = buildReResolvePatch(
      existingItem as unknown as Record<string, unknown>,
      resolved.metadata as unknown as Record<string, unknown>,
      { fields: options?.fields },
    );

    if (updatedFields.length === 0) {
      return {
        success: true,
        message:
          'Item metadata is already up to date with authoritative registry.',
        itemId,
        item: existingItem,
        resolvedFrom: {
          query,
          queryType: resolved.queryType,
          canonicalId: resolved.canonicalId,
        },
        updatedFields: [],
      };
    }

    const expectedVersion = options?.expectedVersion ?? existingItem.version;
    const updated = await this.catalogGateway.updateItem(
      userId,
      itemId,
      updateData,
      { expectedVersion, projectId },
    );

    return {
      success: true,
      message: `Successfully re-resolved metadata from ${resolved.canonicalId || query}. Updated ${updatedFields.length} field(s): ${updatedFields.join(', ')}.`,
      itemId,
      item: updated || existingItem,
      resolvedFrom: {
        query,
        queryType: resolved.queryType,
        canonicalId: resolved.canonicalId,
      },
      updatedFields,
    };
  }
}
