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
import { CATALOG_FACADE, ICatalogFacade } from '@/modules/library/core';
import { DoiContentNegotiationService } from './doi-content-negotiation.service';
import { CslEngineService } from './csl-engine.service';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '@/modules/library/core/constants/academic-client.constants';
import { CslRepositoryService } from './csl-repository.service';

export type { ReferenceData };

interface MetadataPortResolveResult {
  metadata?: Record<string, unknown>;
  provenance?: Record<string, { provider?: string }>;
  queryType?: string;
}

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);
  private readonly registry = new CslStyleRegistry();

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
  ) {}

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

  private get crossRefMailto(): string {
    return getAcademicContactEmail();
  }

  /**
   * Resolves a DOI via CrossRef API.
   */
  async resolveDoi(rawDoi: string): Promise<ReferenceData> {
    const clean = rawDoi
      .trim()
      .replace(/^https?:\/\/doi\.org\//i, '')
      .replace(/^doi:/i, '');
    if (!clean) {
      throw new BadRequestException('Invalid DOI provided');
    }

    try {
      const mailto = this.crossRefMailto;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://api.crossref.org/works/${encodeURIComponent(clean)}?mailto=${encodeURIComponent(mailto)}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': getAcademicUserAgent('Citation'),
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (!res.ok) {
        throw new NotFoundException(
          `DOI not found on CrossRef (${res.status})`,
        );
      }

      const json = await res.json();
      const message = json?.message;
      return this.mapCrossRefMessage(message);
    } catch (err: unknown) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      )
        throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to resolve DOI: ${errMsg}`);
    }
  }

  /**
   * Searches CrossRef API for references matching query.
   */
  async searchCrossRef(
    query: string,
    rows: number = 5,
  ): Promise<{ works: ReferenceData[]; totalResults: number }> {
    if (!query?.trim()) {
      return { works: [], totalResults: 0 };
    }

    try {
      const mailto = this.crossRefMailto;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://api.crossref.org/works?query=${encodeURIComponent(query.trim())}&rows=${rows}&mailto=${encodeURIComponent(mailto)}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': getAcademicUserAgent('Citation'),
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (!res.ok) {
        return { works: [], totalResults: 0 };
      }

      const json = await res.json();
      const items = json?.message?.items || [];
      const totalResults = json?.message?.['total-results'] || items.length;
      const works = (
        items as Array<Parameters<typeof this.mapCrossRefMessage>[0]>
      ).map((item) => this.mapCrossRefMessage(item));
      return { works, totalResults };
    } catch {
      return { works: [], totalResults: 0 };
    }
  }

  private mapItemMetadataToReferenceData(
    metadata: Record<string, unknown>,
  ): ReferenceData {
    let authors: string[] = [];
    if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
      authors = metadata.authors as string[];
    } else if (
      Array.isArray(metadata.creators) &&
      metadata.creators.length > 0
    ) {
      authors = (
        metadata.creators as Array<{
          name?: string;
          firstName?: string;
          lastName?: string;
        }>
      )
        .map((c) => {
          if (c.name) return c.name;
          const parts = [c.firstName, c.lastName].filter(Boolean);
          return parts.join(' ');
        })
        .filter(Boolean);
    }

    let year: number | string | undefined =
      (metadata.year as number | string) ?? undefined;
    if (!year && metadata.publicationDate) {
      const yearMatch = String(metadata.publicationDate).match(/\b(\d{4})\b/);
      if (yearMatch) {
        year = parseInt(yearMatch[1], 10);
      } else {
        const parsedYear = new Date(
          metadata.publicationDate as string | number | Date,
        ).getUTCFullYear();
        if (!isNaN(parsedYear)) {
          year = parsedYear;
        }
      }
    }

    const combinedTags = normalizeTags([
      ...((metadata.keywords as string[]) || []),
      ...((metadata.tags as string[]) || []),
    ]);

    return {
      doi: metadata.doi as string | undefined,
      title: (metadata.title as string) || '',
      authors: authors.length > 0 ? authors : undefined,
      creators: (
        metadata.creators as
          | Array<{
              creatorType?: string;
              name?: string;
              firstName?: string;
              lastName?: string;
            }>
          | undefined
      )?.map((c) => ({
        creatorType: c.creatorType || 'author',
        name:
          c.name || [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
        firstName: c.firstName ?? undefined,
        lastName: c.lastName ?? undefined,
      })),
      year,
      journal: (metadata.journal || metadata.publicationTitle) as
        string | undefined,
      publicationTitle: (metadata.publicationTitle || metadata.journal) as
        string | undefined,
      publicationDate: (metadata.publicationDate || metadata.date) as
        string | undefined,
      publisher: metadata.publisher as string | undefined,
      volume: metadata.volume as string | undefined,
      issue: metadata.issue as string | undefined,
      pages: metadata.pages as string | undefined,
      issn: metadata.issn as string | undefined,
      isbn: metadata.isbn as string | undefined,
      arxivId: metadata.arxivId as string | undefined,
      pmid: metadata.pmid as string | undefined,
      pmcid: metadata.pmcid as string | undefined,
      url:
        (metadata.url as string | undefined) ||
        (metadata.openAccessPdfUrl as string | undefined) ||
        (metadata.doi ? `https://doi.org/${metadata.doi}` : undefined),
      openAccessPdfUrl: (metadata.openAccessPdfUrl || metadata.pdfUrl) as
        string | undefined,
      abstract: (metadata.abstract || metadata.abstractNote) as
        string | undefined,
      citationCount: metadata.citationCount as number | undefined,
      keywords: combinedTags,
      tags: combinedTags,
      type:
        (metadata.type as string | undefined) ||
        (metadata.itemType as string | undefined) ||
        'journal-article',
      itemType:
        (metadata.itemType as string | undefined) ||
        (metadata.type as string | undefined) ||
        'journalArticle',
      extraFields: metadata.extraFields as Record<string, unknown> | undefined,
      provenance: metadata.provenance as Record<string, unknown> | undefined,
    };
  }

  /**
   * Intelligently resolves academic queries (DOI, arXiv ID, PMID, ISBN, URL, or title/keyword search).
   * Gracefully returns { found: false, ... } without throwing 404 exceptions on misses.
   */
  async resolveAcademicQuery(
    rawQuery: string,
    rawDoi?: string,
    userId?: string,
  ): Promise<{
    found: boolean;
    work: ReferenceData | null;
    data: ReferenceData | null;
    metadata: ReferenceData | null;
    provider: string;
    queryType:
      | 'doi'
      | 'arxiv'
      | 'title'
      | 'pmid'
      | 'isbn'
      | 'url'
      | 'unknown'
      | (string & {});
  }> {
    const input = (rawDoi || rawQuery || '').trim();
    if (!input) {
      return {
        found: false,
        work: null,
        data: null,
        metadata: null,
        provider: 'CrossRef',
        queryType: 'unknown',
      };
    }

    // 1. Attempt resolution via the 7-provider unified MetadataPort pipeline
    if (this.metadataPort) {
      try {
        const resolved = await this.metadataPort.resolve({
          query: input,
          userId,
        });

        if (
          resolved?.metadata &&
          (resolved.metadata.title || resolved.metadata.doi)
        ) {
          const work = this.mapItemMetadataToReferenceData(resolved.metadata);
          const firstProv = Object.values(resolved.provenance || {})[0] as
            { provider?: string } | undefined;
          const primaryProvider =
            resolved.provenance?.title?.provider ||
            resolved.provenance?.doi?.provider ||
            firstProv?.provider ||
            'AcademicMetadata';

          return {
            found: true,
            work,
            data: work,
            metadata: work,
            provider: primaryProvider,
            queryType: (resolved.queryType || 'unknown').toLowerCase(),
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `MetadataPort resolution failed for "${input}": ${message}`,
        );
      }
    }

    // 2. DOI Fallback
    const cleanDoiCandidate = this.doiService
      ? this.doiService.cleanDoi(input) || input
      : input
          .replace(/^https?:\/\/doi\.org\//i, '')
          .replace(/^https?:\/\/dx\.doi\.org\//i, '')
          .replace(/^doi:\s*/i, '')
          .trim();

    const isDoi = this.doiService
      ? this.doiService.isDoi(cleanDoiCandidate)
      : /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+$/i.test(cleanDoiCandidate);

    if (isDoi) {
      try {
        const work = await this.resolveDoi(cleanDoiCandidate);
        return {
          found: true,
          work,
          data: work,
          metadata: work,
          provider: 'CrossRef',
          queryType: 'doi',
        };
      } catch {
        if (this.doiService) {
          try {
            const cslWork =
              await this.doiService.resolveMetadata(cleanDoiCandidate);
            if (cslWork && cslWork.title && cslWork.title !== 'Untitled') {
              return {
                found: true,
                work: cslWork,
                data: cslWork,
                metadata: cslWork,
                provider: 'doi.org/DataCite',
                queryType: 'doi',
              };
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.debug(
              `DOI Content Negotiation failed for "${cleanDoiCandidate}": ${message}`,
            );
          }
        }
      }

      return {
        found: false,
        work: null,
        data: null,
        metadata: null,
        provider: 'CrossRef',
        queryType: 'doi',
      };
    }

    // 3. Title / Keyword Search via CrossRef
    try {
      const searchRes = await this.searchCrossRef(input, 1);
      if (searchRes.works && searchRes.works.length > 0) {
        const topWork = searchRes.works[0];
        return {
          found: true,
          work: topWork,
          data: topWork,
          metadata: topWork,
          provider: 'CrossRef',
          queryType: 'title',
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `CrossRef search failed for query "${input}": ${message}`,
      );
    }

    return {
      found: false,
      work: null,
      data: null,
      metadata: null,
      provider: 'CrossRef',
      queryType: 'title',
    };
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

  private mapCrossRefMessage(
    message:
      | {
          title?: string | string[];
          author?: Array<{ given?: string; family?: string; name?: string }>;
          'published-print'?: { 'date-parts'?: (number | string)[][] };
          'published-online'?: { 'date-parts'?: (number | string)[][] };
          issued?: { 'date-parts'?: (number | string)[][] };
          DOI?: string;
          'container-title'?: string | string[];
          publisher?: string;
          volume?: string;
          issue?: string;
          page?: string;
          ISSN?: string | string[];
          ISBN?: string | string[];
          URL?: string;
          abstract?: string;
          type?: string;
          score?: number;
        }
      | null
      | undefined,
  ): ReferenceData {
    const title = Array.isArray(message?.title)
      ? message.title[0] || 'Untitled'
      : message?.title || 'Untitled';
    const authors: string[] = [];
    if (Array.isArray(message?.author)) {
      for (const auth of message.author) {
        if (auth.given && auth.family)
          authors.push(`${auth.family}, ${auth.given}`);
        else if (auth.family) authors.push(auth.family);
        else if (auth.name) authors.push(auth.name);
      }
    }
    let year: number | string = '';
    const dateParts =
      message?.['published-print']?.['date-parts']?.[0] ||
      message?.['published-online']?.['date-parts']?.[0] ||
      message?.issued?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) year = Number(dateParts[0]);

    return {
      doi: message?.DOI || '',
      title,
      authors,
      year,
      journal: Array.isArray(message?.['container-title'])
        ? message['container-title'][0]
        : message?.['container-title'] || '',
      publisher: message?.publisher || '',
      volume: message?.volume || '',
      issue: message?.issue || '',
      pages: message?.page || '',
      issn: Array.isArray(message?.ISSN)
        ? message.ISSN[0]
        : message?.ISSN || '',
      isbn: Array.isArray(message?.ISBN)
        ? message.ISBN[0]
        : message?.ISBN || '',
      url:
        message?.URL || (message?.DOI ? `https://doi.org/${message.DOI}` : ''),
      abstract: message?.abstract
        ? message.abstract.replace(/<[^>]*>/g, '')
        : '',
      type: message?.type || 'journal-article',
      itemType:
        message?.type === 'journal-article'
          ? 'journalArticle'
          : message?.type || 'journalArticle',
      score: message?.score || 0,
    };
  }
}
