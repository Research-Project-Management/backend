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
  ReconcileExtractedCandidatePayload,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
  isPlaceholderItemTitle,
  titleSimilarity,
} from '@/modules/library/core';
import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  METADATA_PORT,
  MetadataPort,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  buildEnrichmentPatch,
  buildReResolvePatch,
} from '@/modules/library/ingestion/domain/enrichment-patch.builder';
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

    const existingExtra: Record<string, unknown> = {
      ...(((existingItem as unknown as { metadata?: Record<string, unknown> }).metadata &&
      typeof (existingItem as unknown as { metadata?: Record<string, unknown> }).metadata === 'object'
        ? (existingItem as unknown as { metadata?: Record<string, unknown> }).metadata
        : {}) as Record<string, unknown>),
      ...((existingItem.extraFields && typeof existingItem.extraFields === 'object'
        ? existingItem.extraFields
        : {}) as Record<string, unknown>),
    };

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
    } else if (existingExtra.arxivId || existingItem.arxivId) {
      const candArxiv = existingExtra.arxivId ?? existingItem.arxivId;
      const rawArxiv =
        typeof candArxiv === 'string' || typeof candArxiv === 'number'
          ? String(candArxiv)
          : '';
      query = normalizeArxivId(rawArxiv) || rawArxiv;
      queryType = 'ARXIV';
    } else if (existingExtra.pmid || existingItem.pmid) {
      const candPmid = existingExtra.pmid ?? existingItem.pmid;
      const rawPmid =
        typeof candPmid === 'string' || typeof candPmid === 'number'
          ? String(candPmid)
          : '';
      query = normalizePmid(rawPmid) || rawPmid;
      queryType = 'PMID';
    } else if (existingItem.isbn || typeof existingExtra.isbn === 'string') {
      const rawIsbn = existingItem.isbn || String(existingExtra.isbn);
      query = normalizeIsbn(rawIsbn) || rawIsbn;
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

    if (queryType === 'TITLE') {
      const extractSurnames = (itemObj: Record<string, unknown>): string[] => {
        const out: string[] = [];
        const creators = Array.isArray(itemObj.creators)
          ? itemObj.creators
          : Array.isArray(itemObj.contributors)
            ? itemObj.contributors
            : [];
        for (const c of creators) {
          if (c && typeof c === 'object') {
            const cObj = c as {
              lastName?: string;
              fullName?: string;
              name?: string;
            };
            const raw = (
              cObj.lastName ||
              (cObj.fullName || cObj.name || '').trim().split(/\s+/).pop() ||
              ''
            )
              .replace(/[đĐ]/g, 'd')
              .normalize('NFKD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]/gu, '');
            if (raw.length >= 2) out.push(raw);
          } else if (typeof c === 'string') {
            const parts = c.trim().split(/\s+/);
            const raw = (
              c.includes(',') ? c.split(',')[0] : parts[parts.length - 1] || ''
            )
              .replace(/[đĐ]/g, 'd')
              .normalize('NFKD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]/gu, '');
            if (raw.length >= 2) out.push(raw);
          }
        }
        if (out.length === 0 && Array.isArray(itemObj.authors)) {
          for (const a of itemObj.authors) {
            if (typeof a === 'string' && a.trim()) {
              const parts = a.trim().split(/\s+/);
              const raw = (
                a.includes(',')
                  ? a.split(',')[0]
                  : parts[parts.length - 1] || ''
              )
                .replace(/[đĐ]/g, 'd')
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]/gu, '');
              if (raw.length >= 2) out.push(raw);
            }
          }
        }
        return out;
      };

      const existingSurnames = extractSurnames(
        existingItem as unknown as Record<string, unknown>,
      );
      const resolvedSurnames = extractSurnames(
        resolved.metadata as unknown as Record<string, unknown>,
      );

      if (existingSurnames.length > 0 && resolvedSurnames.length > 0) {
        const resolvedSet = new Set(resolvedSurnames);
        const sharesAuthor = existingSurnames.some((s) => resolvedSet.has(s));
        if (!sharesAuthor) {
          return {
            success: false,
            message: `Resolved candidate for title "${query}" rejected due to author mismatch with existing item.`,
            itemId,
            item: existingItem,
            updatedFields: [],
          };
        }
      } else if (
        existingSurnames.length === 0 &&
        existingItem.year &&
        resolved.metadata.year
      ) {
        if (
          Math.abs(Number(existingItem.year) - Number(resolved.metadata.year)) >
          1
        ) {
          return {
            success: false,
            message: `Resolved candidate for title "${query}" rejected due to publication year mismatch (${existingItem.year} vs ${resolved.metadata.year}).`,
            itemId,
            item: existingItem,
            updatedFields: [],
          };
        }
      }
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

  /**
   * Single Metadata Authority reconciliation for Pass-2 / OCR / Extraction-discovered metadata.
   * Ensures any DOI/arXiv/PMID/ISBN discovered by deep PDF extraction or OCR goes through:
   * 1. External registry resolution (Crossref/arXiv/PubMed)
   * 2. Page-1 Citation Trap Disambiguation Guard (titleSimilarity >= 0.4 against credible PDF title)
   * 3. Authority-aware field upgrade & UserOverride lock preservation (`buildEnrichmentPatch`)
   */
  async reconcileExtractedCandidate(
    payload: ReconcileExtractedCandidatePayload,
  ): Promise<{ updated: boolean; updatedFields: string[]; rejectedCitedDoi?: string }> {
    if (!this.catalogGateway || !this.metadataService) {
      return { updated: false, updatedFields: [] };
    }

    const { userId, projectId, itemId, extractedMetadata } = payload;
    const existingItem = await this.catalogGateway
      .getItem(userId, itemId, projectId || undefined)
      .catch(() => null);
    if (!existingItem) {
      return { updated: false, updatedFields: [] };
    }

    const cleanDoi =
      typeof extractedMetadata.doi === 'string'
        ? normalizeDoi(extractedMetadata.doi) || extractedMetadata.doi.trim()
        : undefined;
    const cleanArxiv =
      typeof extractedMetadata.arxivId === 'string'
        ? normalizeArxivId(extractedMetadata.arxivId) ||
          extractedMetadata.arxivId.trim()
        : undefined;
    const cleanPmid =
      typeof extractedMetadata.pmid === 'string' ||
      typeof extractedMetadata.pmid === 'number'
        ? normalizePmid(extractedMetadata.pmid) ||
          String(extractedMetadata.pmid).trim()
        : undefined;
    const cleanIsbn =
      typeof extractedMetadata.isbn === 'string'
        ? normalizeIsbn(extractedMetadata.isbn) ||
          extractedMetadata.isbn.trim()
        : undefined;

    let query: string | undefined;
    let queryType: QueryType | undefined;
    if (cleanDoi) {
      query = cleanDoi;
      queryType = 'DOI';
    } else if (cleanArxiv) {
      query = cleanArxiv;
      queryType = 'ARXIV';
    } else if (cleanPmid) {
      query = cleanPmid;
      queryType = 'PMID';
    } else if (cleanIsbn) {
      query = cleanIsbn;
      queryType = 'ISBN';
    }

    if (!query || !queryType) {
      return { updated: false, updatedFields: [] };
    }

    const resolved = await this.metadataService
      .resolve({
        query,
        queryType,
        forceRefresh: false,
        scopeId: projectId || 'user',
      })
      .catch(() => null);

    if (!resolved?.metadata) {
      return { updated: false, updatedFields: [] };
    }

    const existingExtra: Record<string, unknown> = {
      ...(((existingItem as unknown as { metadata?: Record<string, unknown> }).metadata &&
      typeof (existingItem as unknown as { metadata?: Record<string, unknown> }).metadata === 'object'
        ? (existingItem as unknown as { metadata?: Record<string, unknown> }).metadata
        : {}) as Record<string, unknown>),
      ...((existingItem.extraFields && typeof existingItem.extraFields === 'object'
        ? existingItem.extraFields
        : {}) as Record<string, unknown>),
    };

    // Page-1 Citation Disambiguation Guard:
    // Verify that the extracted DOI/identifier does not belong to a cited paper on page 1.
    const pdfTitle = String(
      (typeof extractedMetadata.title === 'string'
        ? extractedMetadata.title
        : '') ||
        (!isPlaceholderItemTitle(existingItem.title) &&
        existingExtra.isFilenameTitle !== true
          ? existingItem.title
          : '') ||
        '',
    ).trim();
    const isCrediblePdfTitle =
      pdfTitle.length >= 10 &&
      !isPlaceholderItemTitle(pdfTitle) &&
      !/^manuscript$/i.test(pdfTitle) &&
      !/^\d{4}\s*\d{4,5}(v\d+)?$/i.test(pdfTitle) &&
      !/^arxiv/i.test(pdfTitle);

    if (isCrediblePdfTitle && resolved.metadata.title) {
      const sim = titleSimilarity(resolved.metadata.title, pdfTitle);
      if (sim < 0.4) {
        this.logger.warn(
          `[SingleAuthorityReconcile] Page-1 Citation Trap Blocked for item ${itemId}: Extracted ${queryType}="${query}" resolved to "${resolved.metadata.title}", which conflicts with PDF title "${pdfTitle}" (similarity=${(sim * 100).toFixed(0)}%).`,
        );

        const rejectedCitedDoi = cleanDoi || query;
        const currentDoiNorm = existingItem.doi
          ? normalizeDoi(existingItem.doi) || existingItem.doi.trim().toLowerCase()
          : '';
        const lockedFields = Array.isArray(existingExtra.lockedFields)
          ? (existingExtra.lockedFields as string[])
          : [];
        const provenance =
          existingExtra.fieldProvenance && typeof existingExtra.fieldProvenance === 'object'
            ? (existingExtra.fieldProvenance as Record<string, { locked?: boolean }>)
            : {};
        const isDoiLocked =
          lockedFields.includes('doi') || provenance.doi?.locked === true;

        if (
          cleanDoi &&
          currentDoiNorm &&
          currentDoiNorm === cleanDoi.toLowerCase() &&
          !isDoiLocked
        ) {
          const nextExtra = { ...existingExtra, rejectedCitedDoi };
          delete nextExtra.doi;
          await this.catalogGateway
            .updateItem(
              userId,
              itemId,
              {
                doi: null,
                extraFields: nextExtra,
                __isSystemUpdate: true,
                __updateSource: 'ingestion.citation_trap_guard',
              },
              {
                expectedVersion: existingItem.version,
                projectId: projectId || undefined,
              },
            )
            .catch(() => undefined);
        }

        return {
          updated: false,
          updatedFields: [],
          rejectedCitedDoi,
        };
      }
    }

    const sourceProvider =
      (resolved.metadata as { sourceProvider?: string }).sourceProvider ||
      (queryType === 'ARXIV' ? 'arXiv' : queryType === 'PMID' ? 'PubMed' : 'CrossRef');
    const proposedPayload: Record<string, unknown> = {
      ...(resolved.metadata as unknown as Record<string, unknown>),
      sourceProvider,
      extraFields: {
        ...((resolved.metadata.extraFields as Record<string, unknown>) || {}),
        engineUsed: sourceProvider,
        isVerified: true,
      },
    };

    const enrichPatch = buildEnrichmentPatch(
      existingItem as unknown as Record<string, unknown>,
      proposedPayload,
    );
    const updatedFields = Object.keys(enrichPatch).filter(
      (k) => !k.startsWith('__'),
    );
    if (updatedFields.length === 0) {
      return { updated: false, updatedFields: [] };
    }

    await this.catalogGateway.updateItem(
      userId,
      itemId,
      enrichPatch,
      {
        expectedVersion: existingItem.version,
        projectId: projectId || undefined,
      },
    );

    return { updated: true, updatedFields };
  }
}
