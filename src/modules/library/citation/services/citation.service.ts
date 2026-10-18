import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { CslStyleRegistry } from '@/modules/library/citation/domain/csl-style-registry';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
  ReferenceData,
  CatalogItemRecord,
} from '@/modules/library/citation/types/citation.types';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  AcademicHttpClient,
} from '@/modules/library/core';
import { DoiContentNegotiationService } from './doi-content-negotiation.service';
import { CslEngineService } from './csl-engine.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslRepositoryService } from './csl-repository.service';
import {
  AcademicQueryResolverService,
  MetadataPortResolveResult,
} from './academic-query-resolver.service';

export type { ReferenceData };
export { AcademicQueryResolverService };

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);
  private readonly registry = new CslStyleRegistry();
  private readonly queryResolver: AcademicQueryResolverService;

  constructor(
    @Optional()
    private readonly doiService?: DoiContentNegotiationService,
    @Optional()
    private readonly cslEngine: CslEngineService = new CslEngineService(),
    @Optional()
    private readonly cslRepo?: CslRepositoryService,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
    @Optional()
    @Inject('METADATA_PORT')
    private readonly metadataPort?: {
      resolve: (req: {
        query: string;
        userId?: string;
      }) => Promise<MetadataPortResolveResult | null | undefined>;
    },
    @Optional()
    private readonly httpClient?: AcademicHttpClient,
    @Optional()
    queryResolver?: AcademicQueryResolverService,
  ) {
    this.queryResolver =
      queryResolver ??
      new AcademicQueryResolverService(
        this.doiService,
        this.metadataPort,
        this.httpClient,
      );
  }

  /**
   * Search across 10,000+ CSL styles from official repository.
   */
  async searchStyles(query: string = '', limit: number = 30) {
    if (!this.cslRepo) return [];
    return this.cslRepo.searchStyles(query, limit);
  }

  /**
   * Registers an uploaded custom CSL XML stylesheet.
   */
  async registerCustomStyle(cslXml: string, title?: string) {
    if (!this.cslRepo) {
      throw new BadRequestException('CSL repository service unavailable');
    }
    const meta = await this.cslRepo.registerCustomStyle(cslXml, title);
    await this.cslEngine.ensureTemplate(meta.id);
    const validCategory = (
      meta.category &&
      ['author-date', 'numeric', 'label', 'raw'].includes(meta.category)
        ? meta.category
        : 'author-date'
    ) as 'author-date' | 'numeric' | 'label' | 'raw';
    this.registry.registerStyle({
      id: meta.id,
      name: meta.title,
      category: validCategory,
    });
    return meta;
  }

  /**
   * Returns list of supported CSL styles.
   */
  getAvailableStyles() {
    return this.registry.listStyles();
  }

  /**
   * Formats a single citation item in the requested style using official CSL engine.
   */
  formatItem(
    item: CitationItemInput,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ): FormattedCitationResult {
    const isSupported =
      this.registry.has(styleId) ||
      Boolean(this.cslEngine?.isStyleSupported?.(styleId));
    if (!isSupported) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }
    const style = this.registry.getStyle(styleId);

    if (this.cslEngine) {
      try {
        const cslItem = CslJsonMapper.toCsl(item);
        const res = this.cslEngine.format(cslItem, styleId, index);
        return {
          styleId,
          inText: res.inText,
          bibliography: res.bibliography,
          bibliographyHtml: res.bibliographyHtml,
          source: 'csl-engine',
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CslEngineService format error: ${errMsg}. Falling back to default format.`,
        );
      }
    }

    return style.format(item, index);
  }

  /**
   * Asynchronously formats a single citation item, ensuring dynamic CSL templates are loaded on-demand.
   */
  async formatItemAsync(
    item: CitationItemInput,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ): Promise<FormattedCitationResult> {
    if (this.cslEngine) {
      const loaded = await this.cslEngine.ensureTemplate(styleId);
      if (loaded && !this.registry.has(styleId)) {
        this.registry.registerStyle({
          id: styleId,
          name: styleId,
          category: 'author-date',
        });
      }
    }
    return this.formatItem(item, styleId, index);
  }

  /**
   * Formats a batch of citation items into ordered in-text citations and complete bibliography.
   */
  formatBatch(
    items: CitationItemInput[],
    styleId: CitationStyleId = 'apa-7th',
  ): {
    styleId: CitationStyleId;
    combinedInText: string;
    bibliographyText: string;
    bibliographyHtml?: string;
    citations: Array<{
      id?: string;
      inText: string;
      bibliography: string;
      bibliographyHtml?: string;
    }>;
  } {
    const isSupported =
      this.registry.has(styleId) ||
      Boolean(this.cslEngine?.isStyleSupported?.(styleId));
    if (!isSupported) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }
    const style = this.registry.getStyle(styleId);

    if (this.cslEngine) {
      try {
        const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
        const res = this.cslEngine.formatBatch(cslItems, styleId);
        return {
          styleId,
          combinedInText: res.combinedInText,
          bibliographyText: res.bibliographyText,
          bibliographyHtml: res.bibliographyHtml,
          citations: res.citations,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CslEngineService batch error: ${errMsg}. Falling back to default format.`,
        );
      }
    }

    const citations = items.map((item, idx) => {
      const res = style.format(item, idx + 1);
      return {
        id: item.id,
        inText: res.inText || '',
        bibliography: res.bibliography || '',
        bibliographyHtml: res.bibliographyHtml || '',
      };
    });

    const isNumeric = ['ieee', 'nature', 'vancouver'].some((s) =>
      styleId.includes(s),
    );
    const inTexts = citations
      .map((c) => c.inText.replace(/^\(|\)$/g, ''))
      .filter(Boolean);
    const combinedInText = isNumeric
      ? `[${citations.map((_, idx) => idx + 1).join(', ')}]`
      : `(${inTexts.join('; ')})`;

    const bibliographyText = citations.map((c) => c.bibliography).join('\n\n');

    return {
      styleId,
      combinedInText,
      bibliographyText,
      citations,
    };
  }

  /**
   * Asynchronously formats a batch of citation items, ensuring dynamic CSL templates are loaded on-demand.
   */
  async formatBatchAsync(
    items: CitationItemInput[],
    styleId: CitationStyleId = 'apa-7th',
  ) {
    if (this.cslEngine) {
      const loaded = await this.cslEngine.ensureTemplate(styleId);
      if (loaded && !this.registry.has(styleId)) {
        this.registry.registerStyle({
          id: styleId,
          name: styleId,
          category: 'author-date',
        });
      }
    }
    return this.formatBatch(items, styleId);
  }

  /**
   * Resolves a DOI via CrossRef API.
   */
  async resolveDoi(rawDoi: string): Promise<ReferenceData> {
    return this.queryResolver.resolveDoi(rawDoi);
  }

  /**
   * Searches CrossRef API for references matching query.
   */
  async searchCrossRef(
    query: string,
    rows: number = 5,
  ): Promise<{ works: ReferenceData[]; totalResults: number }> {
    return this.queryResolver.searchCrossRef(query, rows);
  }

  /**
   * Intelligently resolves academic queries (DOI, arXiv ID, PMID, ISBN, URL, or title/keyword search).
   * Gracefully returns { found: false, ... } without throwing 404 exceptions on misses.
   */
  async resolveAcademicQuery(
    rawQuery: string,
    rawDoi?: string,
    userId?: string,
  ) {
    return this.queryResolver.resolveAcademicQuery(rawQuery, rawDoi, userId);
  }

  /**
   * Formats citation directly for a stored Item by ID.
   */
  async formatItemById(
    userId: string,
    itemId: string,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
    projectId?: string,
  ) {
    const item = this.catalogGateway
      ? await this.catalogGateway.getItem<CatalogItemRecord>(
          userId,
          itemId,
          projectId,
        )
      : null;

    if (!item) {
      throw new NotFoundException('Item not found in library');
    }

    // Tier 1: Official In-Process CSL Engine (Instant, Offline-capable, Consistent with library metadata)
    if (this.cslEngine) {
      try {
        await this.cslEngine.ensureTemplate(styleId);
        const cslItem = CslJsonMapper.toCsl(item);
        const engineRes = this.cslEngine.format(cslItem, styleId, index);
        if (engineRes && engineRes.bibliography) {
          return {
            styleId,
            inText: engineRes.inText,
            bibliography: engineRes.bibliography,
            bibliographyHtml: engineRes.bibliographyHtml,
            source: 'csl-engine',
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CslEngineService format error for item ${item.id}: ${message}. Falling back to publisher DOI.`,
        );
      }
    }

    // Tier 2: Fallback to publisher DOI content negotiation if engine had an issue and DOI exists
    if (
      item.doi &&
      this.doiService &&
      styleId !== 'bibtex' &&
      styleId !== 'ris'
    ) {
      const doiCitation = await this.doiService.resolveCitation(
        item.doi,
        styleId,
      );
      if (doiCitation) {
        return {
          styleId,
          inText:
            doiCitation.inText ||
            `(${item.contributors?.[0]?.lastName || 'Anonymous'}, ${item.year || 'n.d.'})`,
          bibliography: doiCitation.bibliography,
          bibliographyHtml: doiCitation.bibliographyHtml,
          source: 'publisher',
        };
      }
    }

    return this.formatItem(
      this.mapCatalogItemToCitationInput(item),
      styleId,
      index,
    );
  }

  private mapCatalogItemToCitationInput(
    item: CatalogItemRecord,
  ): CitationItemInput {
    const mappedCreators = item.contributors?.map((c) => ({
      creatorType: c.creatorType || 'author',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName: c.fullName || undefined,
      name: c.fullName || undefined,
    }));

    return {
      id: item.id,
      title: item.title,
      itemType: item.itemType || 'journalArticle',
      authors:
        item.contributors
          ?.filter((c) => (c.creatorType || 'author') === 'author')
          .map(
            (c) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          ) || [],
      contributors: mappedCreators,
      creators: mappedCreators,
      publicationTitle: item.publicationTitle || undefined,
      journal: item.publicationTitle || undefined,
      publisher: item.publisher || undefined,
      volume: item.volume || undefined,
      issue: item.issue || undefined,
      pages: item.pages || undefined,
      year: item.year || undefined,
      publicationDate:
        typeof item.publicationDate === 'string'
          ? item.publicationDate
          : undefined,
      doi: item.doi || undefined,
      isbn: typeof item.isbn === 'string' ? item.isbn : undefined,
      issn: typeof item.issn === 'string' ? item.issn : undefined,
      pmid: typeof item.pmid === 'string' ? item.pmid : undefined,
      pmcid: typeof item.pmcid === 'string' ? item.pmcid : undefined,
      arxivId: typeof item.arxivId === 'string' ? item.arxivId : undefined,
      url: item.url || undefined,
      citationKey: item.citationKey || undefined,
      place: typeof item.place === 'string' ? item.place : undefined,
      edition:
        typeof item.edition === 'string' || typeof item.edition === 'number'
          ? String(item.edition)
          : undefined,
      series: typeof item.series === 'string' ? item.series : undefined,
      bookTitle:
        typeof item.bookTitle === 'string' ? item.bookTitle : undefined,
      proceedingsTitle:
        typeof item.proceedingsTitle === 'string'
          ? item.proceedingsTitle
          : undefined,
      conferenceName:
        typeof item.conferenceName === 'string'
          ? item.conferenceName
          : undefined,
      thesisType:
        typeof item.thesisType === 'string' ? item.thesisType : undefined,
      reportType:
        typeof item.reportType === 'string' ? item.reportType : undefined,
      versionNumber:
        typeof item.versionNumber === 'string' ? item.versionNumber : undefined,
      accessedAt:
        item.accessedAt instanceof Date || typeof item.accessedAt === 'string'
          ? item.accessedAt
          : undefined,
      abstract: typeof item.abstract === 'string' ? item.abstract : undefined,
      extra: typeof item.extra === 'string' ? item.extra : undefined,
      metadata: item.metadata,
      updatedAt:
        item.updatedAt instanceof Date || typeof item.updatedAt === 'string'
          ? item.updatedAt
          : undefined,
      version:
        typeof item.version === 'number' || typeof item.version === 'string'
          ? item.version
          : undefined,
    };
  }

  /**
   * Formats citations in batch for stored CatalogItems by IDs.
   */
  async formatItemBatch(
    userId: string,
    itemIds: string[],
    styleId: CitationStyleId = 'apa-7th',
    projectId?: string,
  ) {
    const items = this.catalogGateway
      ? await this.catalogGateway.findByIds<CatalogItemRecord>(
          userId,
          itemIds,
          projectId,
        )
      : [];

    let combinedInText = '';
    let bibliographyText = '';
    let bibliographyHtml = '';
    const citationMap = new Map<string, FormattedCitationResult>();

    // Primary Tier: Use official CSL Engine to format the entire batch together
    // This correctly resolves author-date grouping, numeric collapsing [1]-[3], and A-Z / numeric sorting!
    if (this.cslEngine && items.length > 0) {
      await this.cslEngine.ensureTemplate(styleId);
      try {
        const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
        const batchRes = this.cslEngine.formatBatch(cslItems, styleId);
        combinedInText = batchRes.combinedInText;
        bibliographyText = batchRes.bibliographyText;
        bibliographyHtml = batchRes.bibliographyHtml;

        for (const single of batchRes.citations) {
          if (single.id) {
            citationMap.set(single.id, {
              styleId: batchRes.styleId || styleId,
              inText: single.inText,
              bibliography: single.bibliography,
              bibliographyHtml: single.bibliographyHtml,
              source: 'csl-engine',
            });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CslEngineService formatBatch error: ${message}. Falling back to individual formatting.`,
        );
      }
    }

    // Secondary Tier: Fill in any missing items that were not formatted by CslEngine
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (citationMap.has(item.id)) continue;

      let formatted: FormattedCitationResult | undefined;

      // Fallback to publisher DOI content negotiation
      if (
        item.doi &&
        this.doiService &&
        styleId !== 'bibtex' &&
        styleId !== 'ris'
      ) {
        try {
          const doiCitation = await this.doiService.resolveCitation(
            item.doi,
            styleId,
          );
          if (doiCitation) {
            formatted = {
              styleId,
              inText:
                doiCitation.inText ||
                `(${item.contributors?.[0]?.lastName || 'Anonymous'}, ${item.year || 'n.d.'})`,
              bibliography: doiCitation.bibliography,
              bibliographyHtml: doiCitation.bibliographyHtml,
              source: 'publisher',
            };
          }
        } catch {
          // ignore
        }
      }

      if (!formatted) {
        formatted = this.formatItem(
          this.mapCatalogItemToCitationInput(item),
          styleId,
          index + 1,
        );
      }

      citationMap.set(item.id, formatted);
    }

    const citations = itemIds.map((id) => ({
      itemId: id,
      paperId: id,
      citation: citationMap.get(id) || {
        styleId,
        inText: '',
        bibliography: '',
      },
    }));

    if (!combinedInText && citations.length > 0) {
      const isNumeric = [
        'ieee',
        'nature',
        'vancouver',
        'the-lancet',
        'science',
      ].some((s) => styleId.includes(s));
      const inTexts = citations
        .map((c) => c.citation?.inText?.replace(/^\(|\)$/g, ''))
        .filter(Boolean);
      combinedInText = isNumeric
        ? `[${citations.map((_, idx) => idx + 1).join(', ')}]`
        : `(${inTexts.join('; ')})`;
    }

    if (!bibliographyText && citations.length > 0) {
      bibliographyText = citations
        .map((c) => c.citation?.bibliography)
        .filter(Boolean)
        .join('\n\n');
    }

    return {
      style: styleId,
      total: citations.length,
      combinedInText,
      bibliographyText,
      bibliographyHtml,
      citations,
    };
  }
}
