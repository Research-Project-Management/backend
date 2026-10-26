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
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';
import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  METADATA_PORT,
  MetadataPort,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import { buildReResolvePatch } from '@/modules/library/ingestion/domain/enrichment-patch.builder';
import { UrlMetadataScraperService } from './url-metadata-scraper.service';

export interface ReResolveMetadataOptions {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  title?: string;
  forceRefresh?: boolean;
  aggressive?: boolean;
  attachOaPdf?: boolean;
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
  oaPdfAttached?: boolean;
  oaPdfUrl?: string;
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
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional()
    private readonly urlScraper?: UrlMetadataScraperService,
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

    let updated: ItemDetail | null = existingItem;
    if (updatedFields.length > 0) {
      const expectedVersion = options?.expectedVersion ?? existingItem.version;
      updated = await this.catalogGateway.updateItem(
        userId,
        itemId,
        updateData,
        { expectedVersion, projectId },
      );
    }

    let oaPdfAttached = false;
    const candidateOaPdfUrl =
      (typeof resolved.metadata.openAccessPdfUrl === 'string' &&
        resolved.metadata.openAccessPdfUrl.trim()) ||
      (typeof resolved.metadata.pdfUrl === 'string' &&
        resolved.metadata.pdfUrl.trim()) ||
      (typeof existingItem.openAccessPdfUrl === 'string' &&
        existingItem.openAccessPdfUrl.trim()) ||
      '';

    const existingHasStoredPdf =
      Boolean(existingItem.fileId) ||
      (Array.isArray(existingItem.attachments) &&
        existingItem.attachments.some((rawAtt: unknown) => {
          const att = rawAtt as {
            fileId?: string | null;
            mimeType?: string | null;
            attachmentType?: string | null;
          } | null;
          return (
            Boolean(att?.fileId) &&
            (att?.mimeType === 'application/pdf' ||
              att?.attachmentType === 'primary_pdf')
          );
        }));

    if (
      options?.attachOaPdf !== false &&
      candidateOaPdfUrl &&
      /^https?:\/\//i.test(candidateOaPdfUrl) &&
      !existingHasStoredPdf &&
      this.urlScraper &&
      this.extractionGateway?.createAttachment
    ) {
      try {
        const scraped = await this.urlScraper.scrape(candidateOaPdfUrl, {
          scopeId: projectId || userId,
          userId,
        });
        if (scraped?.isPdf && scraped.fileId) {
          await this.extractionGateway.createAttachment(
            {
              itemId,
              fileId: scraped.fileId,
              filename:
                scraped.filename ||
                (existingItem.title
                  ? `${existingItem.title.slice(0, 60).replace(/[<>:"/\\|?*]/g, '')}.pdf`
                  : 'open-access.pdf'),
              url: getFileContentPath(scraped.fileId),
              mimeType: 'application/pdf',
              size: scraped.fileBuffer?.length || 0,
              userId,
            },
            projectId,
          );
          oaPdfAttached = true;
          updated =
            (await this.catalogGateway
              .getItem(userId, itemId, projectId)
              .catch(() => updated)) || updated;
        }
      } catch (oaErr: unknown) {
        this.logger.debug(
          `[RE_RESOLVE_OA_PDF] Could not download/attach OA PDF from ${candidateOaPdfUrl}: ${oaErr instanceof Error ? oaErr.message : String(oaErr)}`,
        );
      }
    }

    if (updatedFields.length === 0 && !oaPdfAttached) {
      return {
        success: true,
        message:
          'Item metadata is already up to date with authoritative registry.',
        itemId,
        item: updated || existingItem,
        resolvedFrom: {
          query,
          queryType: resolved.queryType,
          canonicalId: resolved.canonicalId,
        },
        updatedFields: [],
        oaPdfAttached: false,
        oaPdfUrl: candidateOaPdfUrl || undefined,
      };
    }

    return {
      success: true,
      message: `Successfully re-resolved metadata from ${resolved.canonicalId || query}. Updated ${updatedFields.length} field(s)${oaPdfAttached ? ' and attached Open-Access PDF' : ''}.`,
      itemId,
      item: updated || existingItem,
      resolvedFrom: {
        query,
        queryType: resolved.queryType,
        canonicalId: resolved.canonicalId,
      },
      updatedFields,
      oaPdfAttached,
      oaPdfUrl: candidateOaPdfUrl || undefined,
    };
  }
}
