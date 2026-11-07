import { Injectable, Logger, BadRequestException, NotFoundException, Optional, Inject } from '@nestjs/common';
import { CslStyleRegistry, BUILTIN_SPECIAL_STYLES, NUMERIC_STYLE_TOKENS, MAX_DYNAMIC_CSL_STYLES, normalizeCitationStyleId } from '@/modules/library/citation/domain/citation.domain';
import { CitationStyleId, CitationItemInput, CitationContextOptions, FormattedCitationResult, ReferenceData, CatalogItemRecord } from '@/modules/library/citation/types/citation.types';
import { CATALOG_FACADE, METADATA_PORT, ICatalogFacade, HttpClient, normalizeProjectScopeId } from '@/modules/library/core';
import { DoiContentNegotiationService } from './doi-content-negotiation.service';
import { CslEngineService } from './csl-engine.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslRepositoryService } from './csl-repository.service';
import { QueryResolverService, MetadataPortResolveResult } from './query-resolver.service';

export type { ReferenceData };
export { QueryResolverService };

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);

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
    @Inject(METADATA_PORT)
    private readonly metadataPort?: {
      resolve: (req: {
        query: string;
        userId?: string;
      }) => Promise<MetadataPortResolveResult | null | undefined>;
    },
    @Optional()
    private readonly httpClient?: HttpClient,
    @Optional()
    private readonly queryResolver: QueryResolverService = new QueryResolverService(
      this.doiService,
      this.metadataPort,
      this.httpClient,
    ),
    @Optional()
    private readonly registry: CslStyleRegistry = new CslStyleRegistry(),
  ) {}

  /**
   * Search across 10,000+ CSL styles from official repository.
   */
  async searchStyles(query: string = '', limit: number = 30, scopeId?: string) {
    if (!this.cslRepo) return [];
    return this.cslRepo.searchStyles(query, limit, scopeId);
  }

  /**
   * Registers an uploaded custom CSL XML stylesheet.
   */
  async registerCustomStyle(
    cslXml: string,
    title?: string,
    scopeId?: string,
    actorUserId?: string,
  ) {
    if (!this.cslRepo) {
      throw new BadRequestException('CSL repository service unavailable');
    }
    const sanitizedTitle =
      typeof title === 'string'
        ? title
            .replace(/<[^>]*>/g, '')
            .replace(/[<>]/g, '')
            .trim()
            .slice(0, 200)
        : undefined;
    const meta = await this.cslRepo.registerCustomStyle(
      cslXml,
      sanitizedTitle || undefined,
      scopeId,
      actorUserId,
    );
    await this.cslEngine.ensureTemplate(meta.id, scopeId, cslXml);
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
   * Alias for registering a custom CSL XML stylesheet.
   */
  async uploadCustomStyle(cslXml: string, title?: string, scopeId?: string) {
    return this.registerCustomStyle(cslXml, title, scopeId);
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
    context?: CitationContextOptions,
  ): FormattedCitationResult {
    const isSupported =
      this.registry.has(styleId) ||
      Boolean(this.cslEngine.isStyleSupported(styleId));
    if (!isSupported) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }

    const cslItem = CslJsonMapper.toCsl(item);
    const res = this.cslEngine.format(
      cslItem,
      styleId,
      index,
      undefined,
      context,
    );
    return {
      styleId,
      inText: res.inText,
      bibliography: res.bibliography,
      bibliographyHtml: res.bibliographyHtml,
      source: 'csl-engine',
    };
  }

  /**
   * Asynchronously formats a single citation item, ensuring dynamic CSL templates are loaded on-demand.
   */
  async formatItemAsync(
    item: CitationItemInput,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
    context?: CitationContextOptions,
  ): Promise<FormattedCitationResult> {
    const loaded = await this.cslEngine.ensureTemplate(styleId);
    if (loaded && !this.registry.has(styleId)) {
      this.registry.registerStyle({
        id: styleId,
        name: styleId,
        category: 'author-date',
      });
    }
    return this.formatItem(item, styleId, index, context);
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
      Boolean(this.cslEngine.isStyleSupported(styleId));
    if (!isSupported) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }

    const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
    const res = this.cslEngine.formatBatch(cslItems, styleId);
    return {
      styleId,
      combinedInText: res.combinedInText,
      bibliographyText: res.bibliographyText,
      bibliographyHtml: res.bibliographyHtml,
      citations: res.citations,
    };
  }

  /**
   * Asynchronously formats a batch of citation items, ensuring dynamic CSL templates are loaded on-demand.
   */
  async formatBatchAsync(
    items: CitationItemInput[],
    styleId: CitationStyleId = 'apa-7th',
  ) {
    const loaded = await this.cslEngine.ensureTemplate(styleId);
    if (loaded && !this.registry.has(styleId)) {
      this.registry.registerStyle({
        id: styleId,
        name: styleId,
        category: 'author-date',
      });
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
   * Formats citation directly for a stored Item by ID via the authoritative CslEngineService.
   */
  async formatItemById(
    userId: string,
    itemId: string,
    styleId: CitationStyleId | string = 'apa-7th',
    index: number = 1,
    projectId?: string,
    context?: CitationContextOptions,
  ): Promise<FormattedCitationResult> {
    const normalizedStyleId = normalizeCitationStyleId(styleId);
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const scopeId = effectiveProjectId || userId;
    const [item, styleLoaded] = await Promise.all([
      this.catalogGateway
        ? this.catalogGateway.getItem<CatalogItemRecord>(
            userId,
            itemId,
            effectiveProjectId,
          )
        : Promise.resolve(null),
      this.cslEngine.ensureTemplate(normalizedStyleId, scopeId),
    ]);

    if (!item) {
      throw new NotFoundException('Item not found in library');
    }

    if (
      !styleLoaded &&
      !this.registry.has(normalizedStyleId) &&
      !this.cslEngine.isStyleSupported(normalizedStyleId)
    ) {
      throw new BadRequestException(
        `Unsupported citation style: ${normalizedStyleId}`,
      );
    }

    const cslItem = CslJsonMapper.toCsl(item);
    const engineRes = this.cslEngine.format(
      cslItem,
      normalizedStyleId,
      index,
      scopeId,
      context,
    );
    return {
      styleId: normalizedStyleId,
      inText: engineRes.inText,
      bibliography: engineRes.bibliography,
      bibliographyHtml: engineRes.bibliographyHtml,
      source: 'csl-engine',
    };
  }

  /**
   * Formats citations in batch for stored CatalogItems by IDs via CslEngineService.
   */
  async formatItemBatch(
    userId: string,
    itemIds: string[],
    styleId: CitationStyleId | string = 'apa-7th',
    projectId?: string,
  ) {
    const normalizedStyleId = normalizeCitationStyleId(styleId);
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const scopeId = effectiveProjectId || userId;
    const [rawItems] = await Promise.all([
      this.catalogGateway
        ? this.catalogGateway.findByIds<CatalogItemRecord>(
            userId,
            itemIds,
            effectiveProjectId,
          )
        : Promise.resolve([]),
      itemIds.length > 0
        ? this.cslEngine.ensureTemplate(normalizedStyleId, scopeId)
        : Promise.resolve(false),
    ]);
    const itemMap = new Map<string, CatalogItemRecord>();
    for (const it of rawItems) {
      if (it?.id) itemMap.set(it.id, it);
    }
    const items = itemIds
      .map((id) => itemMap.get(id))
      .filter((it): it is CatalogItemRecord => Boolean(it));

    if (items.length === 0) {
      return {
        style: normalizedStyleId,
        total: 0,
        combinedInText: '',
        bibliographyText: '',
        bibliographyHtml: '',
        citations: itemIds.map((id) => ({
          itemId: id,
          citation: { styleId: normalizedStyleId, inText: '', bibliography: '' },
        })),
      };
    }

    const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
    const batchRes = await this.cslEngine.formatBatchAsync(
      cslItems,
      normalizedStyleId,
      scopeId,
    );

    const citationMap = new Map<string, FormattedCitationResult>();
    for (let idx = 0; idx < batchRes.citations.length; idx++) {
      const single = batchRes.citations[idx];
      const formattedSingle: FormattedCitationResult = {
        styleId: batchRes.styleId || normalizedStyleId,
        inText: single.inText,
        bibliography: single.bibliography,
        bibliographyHtml: single.bibliographyHtml,
        source: 'csl-engine',
      };
      const explicitSingleItemId = (single as { itemId?: string }).itemId;
      const matchedCsl = single.id
        ? cslItems.find((c) => c.id === single.id)
        : undefined;
      const matchedItem = single.id
        ? items.find(
            (it) => it.id === single.id || it.citationKey === single.id,
          )
        : undefined;
      const origItemId =
        (typeof explicitSingleItemId === 'string' && explicitSingleItemId
          ? explicitSingleItemId
          : undefined) ??
        (typeof matchedCsl?._itemId === 'string' && matchedCsl._itemId
          ? matchedCsl._itemId
          : undefined) ??
        matchedItem?.id ??
        (single.id ? itemMap.get(single.id)?.id : undefined);
      if (origItemId) {
        citationMap.set(origItemId, formattedSingle);
      }
      if (single.id) {
        citationMap.set(single.id, formattedSingle);
      }
    }

    const citations = itemIds.map((id) => ({
      itemId: id,
      citation: citationMap.get(id) || {
        styleId: normalizedStyleId,
        inText: '',
        bibliography: '',
      },
    }));

    return {
      style: normalizedStyleId,
      total: citations.length,
      combinedInText: batchRes.combinedInText,
      bibliographyText: batchRes.bibliographyText,
      bibliographyHtml: batchRes.bibliographyHtml,
      citations,
    };
  }
}

export { BUILTIN_SPECIAL_STYLES, NUMERIC_STYLE_TOKENS, MAX_DYNAMIC_CSL_STYLES };
