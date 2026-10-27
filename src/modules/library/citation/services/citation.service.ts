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
    private readonly queryResolver: AcademicQueryResolverService = new AcademicQueryResolverService(
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
  async registerCustomStyle(cslXml: string, title?: string, scopeId?: string) {
    if (!this.cslRepo) {
      throw new BadRequestException('CSL repository service unavailable');
    }
    const sanitizedTitle =
      typeof title === 'string'
        ? title.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 200)
        : undefined;
    const meta = await this.cslRepo.registerCustomStyle(
      cslXml,
      sanitizedTitle || undefined,
      scopeId,
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
        await this.cslEngine.ensureTemplate(styleId, projectId || userId);
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
      item as unknown as CitationItemInput,
      styleId,
      index,
    );
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
      const scopeId = projectId || userId;
      try {
        await this.cslEngine.ensureTemplate(styleId, scopeId);
        const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
        const batchRes = this.cslEngine.formatBatchAsync
          ? await this.cslEngine.formatBatchAsync(cslItems, styleId, scopeId)
          : this.cslEngine.formatBatch(cslItems, styleId);
        combinedInText = batchRes.combinedInText;
        bibliographyText = batchRes.bibliographyText;
        bibliographyHtml = batchRes.bibliographyHtml;

        for (let idx = 0; idx < batchRes.citations.length; idx++) {
          const single = batchRes.citations[idx];
          const formattedSingle: FormattedCitationResult = {
            styleId: batchRes.styleId || styleId,
            inText: single.inText,
            bibliography: single.bibliography,
            bibliographyHtml: single.bibliographyHtml,
            source: 'csl-engine',
          };
          const rawItemId = cslItems[idx]?._itemId;
          const origItemId: string | undefined =
            typeof rawItemId === 'string' && rawItemId.length > 0
              ? rawItemId
              : typeof items[idx]?.id === 'string'
                ? items[idx].id
                : undefined;
          if (origItemId) {
            citationMap.set(origItemId, formattedSingle);
          }
          if (single.id) {
            citationMap.set(single.id, formattedSingle);
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
    const missingEntries = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !citationMap.has(item.id));

    await Promise.all(
      missingEntries.map(async ({ item, index }) => {
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
            item as unknown as CitationItemInput,
            styleId,
            index + 1,
          );
        }

        citationMap.set(item.id, formatted);
      }),
    );

    const citations = itemIds.map((id) => ({
      itemId: id,
      citation: citationMap.get(id) || {
        styleId,
        inText: '',
        bibliography: '',
      },
    }));

    const hasFallbackMerge = missingEntries.length > 0;

    if ((!combinedInText || hasFallbackMerge) && citations.length > 0) {
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

    if ((!bibliographyText || hasFallbackMerge) && citations.length > 0) {
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
