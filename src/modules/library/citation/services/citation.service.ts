import { Injectable, Logger, BadRequestException, NotFoundException, Optional, Inject } from '@nestjs/common';
import { CslStyleRegistry, BUILTIN_SPECIAL_STYLES, NUMERIC_STYLE_TOKENS, MAX_DYNAMIC_CSL_STYLES, normalizeEngineStyleId } from '@/modules/library/citation/domain/citation.domain';
import { CitationStyleId, CitationItemInput, CitationContextOptions, FormattedCitationResult, ReferenceData, CatalogItemRecord, ExportResult } from '@/modules/library/citation/types/citation.types';
import { CATALOG_FACADE, METADATA_PORT, ICatalogFacade, HttpClient, normalizeProjectScopeId, CITATION_FACADE, ICitationFacade as ICoreCitationFacade } from '@/modules/library/core';
import { DoiContentNegotiationService } from './doi-content-negotiation.service';
import { CslEngineService } from './csl-engine.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslRepositoryService } from './csl-repository.service';
import { QueryResolverService, MetadataPortResolveResult } from './query-resolver.service';
import { IEEE_CSL, NATURE_CSL, CHICAGO_CSL, MLA_CSL, VI_VN_LOCALE } from '@/modules/library/citation/data/official-styles.data';
import { ExportsService } from '@/modules/library/citation/services/exports.service';
import { ExportLibraryDto } from '@/modules/library/citation/types/citation.types';

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
  async registerCustomStyle(cslXml: string, title?: string, scopeId?: string) {
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
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
    projectId?: string,
    context?: CitationContextOptions,
  ): Promise<FormattedCitationResult> {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const item = this.catalogGateway
      ? await this.catalogGateway.getItem<CatalogItemRecord>(
          userId,
          itemId,
          effectiveProjectId,
        )
      : null;

    if (!item) {
      throw new NotFoundException('Item not found in library');
    }

    const scopeId = effectiveProjectId || userId;
    await this.cslEngine.ensureTemplate(styleId, scopeId);
    const cslItem = CslJsonMapper.toCsl(item);
    const engineRes = this.cslEngine.format(
      cslItem,
      styleId,
      index,
      scopeId,
      context,
    );
    return {
      styleId,
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
    styleId: CitationStyleId = 'apa-7th',
    projectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(projectId);
    const rawItems = this.catalogGateway
      ? await this.catalogGateway.findByIds<CatalogItemRecord>(
          userId,
          itemIds,
          effectiveProjectId,
        )
      : [];
    const itemMap = new Map<string, CatalogItemRecord>();
    for (const it of rawItems) {
      if (it?.id) itemMap.set(it.id, it);
    }
    const items = itemIds
      .map((id) => itemMap.get(id))
      .filter((it): it is CatalogItemRecord => Boolean(it));

    if (items.length === 0) {
      return {
        style: styleId,
        total: 0,
        combinedInText: '',
        bibliographyText: '',
        bibliographyHtml: '',
        citations: itemIds.map((id) => ({
          itemId: id,
          citation: { styleId, inText: '', bibliography: '' },
        })),
      };
    }

    const scopeId = effectiveProjectId || userId;
    await this.cslEngine.ensureTemplate(styleId, scopeId);
    const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
    const batchRes = await this.cslEngine.formatBatchAsync(
      cslItems,
      styleId,
      scopeId,
    );

    const citationMap = new Map<string, FormattedCitationResult>();
    for (let idx = 0; idx < batchRes.citations.length; idx++) {
      const single = batchRes.citations[idx];
      const formattedSingle: FormattedCitationResult = {
        styleId: batchRes.styleId || styleId,
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
        styleId,
        inText: '',
        bibliography: '',
      },
    }));

    return {
      style: styleId,
      total: citations.length,
      combinedInText: batchRes.combinedInText,
      bibliographyText: batchRes.bibliographyText,
      bibliographyHtml: batchRes.bibliographyHtml,
      citations,
    };
  }
}

export { BUILTIN_SPECIAL_STYLES, NUMERIC_STYLE_TOKENS, MAX_DYNAMIC_CSL_STYLES };

interface CitationJsTemplateStore {
  has(id: string): boolean;
  add(id: string, xml: string): void;
  get?(id: string): string | undefined;
  remove?(id: string): void;
  delete?(id: string): boolean;
  data?: Record<string, string>;
}

interface CitationJsPluginConfig {
  format?: { useIdAsLabel?: boolean };
  templates?: CitationJsTemplateStore;
  locales?: CitationJsTemplateStore;
}

interface CitationJsPlugins {
  config: {
    get(name: string): CitationJsPluginConfig | undefined;
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { plugins } = require('@citation-js/core') as {
  plugins: CitationJsPlugins;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-csl');

@Injectable()
export class CslLocaleLoaderService {
  private readonly logger = new Logger(CslLocaleLoaderService.name);
  private templatesInitialized = false;
  private readonly staticTemplateIds = new Set<string>([
    'apa',
    'vancouver',
    'harvard1',
    'ieee',
    'nature',
    'chicago',
    'chicago-author-date',
    'mla',
    'mla-9th',
    'tcvn',
    'tcvn-author-date',
    'tcvn-numeric',
  ]);
  private readonly dynamicTemplateIds = new Set<string>();

  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
  ) {}

  private evictTemplateFromStore(
    templates: CitationJsTemplateStore,
    id: string,
  ): void {
    if (typeof templates.remove === 'function') {
      templates.remove(id);
    } else if (typeof templates.delete === 'function') {
      templates.delete(id);
    } else if (templates.data && typeof templates.data === 'object') {
      delete templates.data[id];
    }
  }

  public initTemplates(): void {
    if (this.templatesInitialized) return;

    try {
      const bibtexConfig = plugins.config.get('@bibtex');
      if (bibtexConfig?.format) {
        bibtexConfig.format.useIdAsLabel = true;
      }

      const csl = plugins.config.get('@csl');
      if (csl?.templates) {
        const templateBindings: ReadonlyArray<[string, string]> = [
          ['ieee', IEEE_CSL],
          ['nature', NATURE_CSL],
          ['chicago', CHICAGO_CSL],
          ['chicago-author-date', CHICAGO_CSL],
          ['mla', MLA_CSL],
          ['mla-9th', MLA_CSL],
        ];
        for (const [id, xml] of templateBindings) {
          this.staticTemplateIds.add(id);
          if (!csl.templates.has(id)) csl.templates.add(id, xml);
        }
      }
      if (csl?.locales) {
        for (const loc of ['vi-VN', 'vi']) {
          if (!csl.locales.has(loc)) csl.locales.add(loc, VI_VN_LOCALE);
        }
      }
      this.templatesInitialized = true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to register CSL templates: ${errMsg}`);
    }
  }

  public getScopedStyleId(styleId: string, scopeId?: string): string {
    const normalized = this.normalizeStyle(styleId);
    if (this.staticTemplateIds.has(normalized) || BUILTIN_SPECIAL_STYLES.has(normalized)) {
      return normalized;
    }
    const scopeKey = scopeId?.trim() || 'global';
    return `${scopeKey}::${normalized}`;
  }

  public isStyleSupported(styleId: string, scopeId?: string): boolean {
    if (!styleId) return false;
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized)) return true;
    const scopedId = this.getScopedStyleId(normalized, scopeId);
    try {
      const csl = plugins.config.get('@csl');
      return Boolean(csl?.templates?.has(scopedId));
    } catch {
      return false;
    }
  }

  public async ensureTemplate(
    styleId: string,
    scopeId?: string,
    rawXml?: string,
  ): Promise<boolean> {
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized)) return true;

    // Protection: Never overwrite official static built-in templates with custom XML
    if (this.staticTemplateIds.has(normalized)) {
      return true;
    }

    const scopedId = this.getScopedStyleId(normalized, scopeId);

    try {
      const csl = plugins.config.get('@csl');
      if (csl?.templates?.has(scopedId) && !rawXml) {
        this.dynamicTemplateIds.delete(scopedId);
        this.dynamicTemplateIds.add(scopedId);
        return true;
      }

      const xml =
        rawXml ||
        (this.cslRepo
          ? await this.cslRepo.fetchCslXml(normalized, scopeId)
          : null);

      if (!xml) {
        return false;
      }

      if (csl?.templates) {
        if (this.dynamicTemplateIds.size >= MAX_DYNAMIC_CSL_STYLES) {
          const oldestId = this.dynamicTemplateIds.values().next().value;
          if (oldestId) {
            this.dynamicTemplateIds.delete(oldestId);
            this.evictTemplateFromStore(csl.templates, oldestId);
          }
        }
        csl.templates.add(scopedId, xml);
        this.dynamicTemplateIds.add(scopedId);
        this.logger.log(
          `Dynamically registered on-demand scoped CSL template: "${scopedId}"`,
        );
        return true;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Could not dynamically load CSL template for "${scopedId}": ${errMsg}`,
      );
    }
    return false;
  }

  public normalizeStyle(styleId: string): string {
    return normalizeEngineStyleId(styleId);
  }

  public getStyleDefaultLocale(styleId: string, scopeId?: string): string {
    this.initTemplates();
    const scopedId = this.getScopedStyleId(styleId, scopeId);
    try {
      const csl = plugins.config.get('@csl');
      const xml =
        typeof csl?.templates?.get === 'function'
          ? csl.templates.get(scopedId)
          : csl?.templates?.data?.[scopedId];
      if (typeof xml === 'string') {
        const match = xml.match(/\bdefault-locale\s*=\s*["']([^"']+)["']/i);
        if (match?.[1]?.trim()) {
          return match[1].trim();
        }
      }
    } catch {
      // Fallback to en-US
    }
    return 'en-US';
  }
}

export { CITATION_FACADE };

export type ICitationFacade = ICoreCitationFacade<
  CitationStyleId,
  FormattedCitationResult,
  ExportLibraryDto,
  ExportResult
>;

@Injectable()
export class CitationFacade implements ICitationFacade {
  constructor(
    private readonly citationService: CitationService,
    private readonly exportsService: ExportsService,
  ) {}

  async formatCitation(
    userId: string,
    itemId: string,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
    projectId?: string,
  ): Promise<FormattedCitationResult> {
    return this.citationService.formatItemById(
      userId,
      itemId,
      styleId,
      index,
      projectId,
    );
  }

  async exportByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }> {
    return this.exportsService.exportByCitationKeys(
      userId,
      citeKeys,
      projectId,
    );
  }

  async exportLibrary(
    userId: string,
    options: ExportLibraryDto = { format: 'bibtex' },
  ): Promise<ExportResult> {
    return this.exportsService.exportLibrary(userId, options);
  }
}
