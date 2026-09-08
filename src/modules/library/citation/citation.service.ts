import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { CslStyleRegistry } from './formatters/csl-style-registry';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
  ReferenceData,
} from './types/citation.types';
import { ItemsService } from '../items/items.service';
import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import { CslEngineService } from './services/csl-engine.service';
import { CslJsonMapper } from './mappers/csl-json.mapper';
import {
  METADATA_PORT,
  MetadataPort,
  ItemMetadata,
} from '../ingestion/metadata/types/metadata.types';
import { normalizeTags } from '../tags/utils/tags.utils';

export type { ReferenceData };

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);
  private readonly registry = new CslStyleRegistry();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly itemsService?: ItemsService,
    @Optional() private readonly doiService?: DoiContentNegotiationService,
    @Optional() private readonly cslEngine?: CslEngineService,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: MetadataPort,
  ) {
    if (!this.doiService) {
      this.doiService = new DoiContentNegotiationService();
    }
    if (!this.cslEngine) {
      this.cslEngine = new CslEngineService();
    }
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
      } catch (err: any) {
        this.logger.warn(
          `CslEngineService format error: ${err?.message || err}. Falling back to registry.`,
        );
      }
    }

    const style = this.registry.getStyle(styleId);
    if (!style) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }
    return style.format(item, index);
  }

  /**
   * Formats a batch of citation items into ordered in-text citations and complete bibliography.
   */
  formatBatch(
    items: CitationItemInput[],
    styleId: CitationStyleId = 'apa-7th',
  ): {
    styleId: CitationStyleId;
    citations: Array<{ id?: string; inText: string; bibliography: string }>;
    bibliographyText: string;
  } {
    if (this.cslEngine) {
      try {
        const cslItems = items.map((it) => CslJsonMapper.toCsl(it));
        const res = this.cslEngine.formatBatch(cslItems, styleId);
        return {
          styleId,
          citations: res.citations,
          bibliographyText: res.bibliographyText,
        };
      } catch (err: any) {
        this.logger.warn(
          `CslEngineService batch error: ${err?.message || err}`,
        );
      }
    }

    const style = this.registry.getStyle(styleId);
    if (!style) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }

    const citations = items.map((item, idx) => {
      const res = style.format(item, idx + 1);
      return {
        id: item.id,
        inText: res.inText,
        bibliography: res.bibliography,
      };
    });

    const bibliographyText = citations.map((c) => c.bibliography).join('\n\n');

    return {
      styleId,
      citations,
      bibliographyText,
    };
  }

  private get crossRefMailto(): string {
    return (
      process.env.CROSSREF_EMAIL ||
      process.env.ACADEMIC_EMAIL ||
      'contact@flux.academic'
    );
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
            'User-Agent': `FluxResearchPlatform/1.0 (mailto:${mailto}; https://flux.study)`,
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
    } catch (err: any) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      )
        throw err;
      throw new BadRequestException(`Failed to resolve DOI: ${err.message}`);
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
            'User-Agent': `FluxResearchPlatform/1.0 (mailto:${mailto}; https://flux.study)`,
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
      const works = items.map((item: any) => this.mapCrossRefMessage(item));
      return { works, totalResults };
    } catch {
      return { works: [], totalResults: 0 };
    }
  }

  private mapItemMetadataToReferenceData(
    metadata: ItemMetadata,
  ): ReferenceData {
    let authors: string[] = [];
    if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
      authors = metadata.authors;
    } else if (
      Array.isArray(metadata.creators) &&
      metadata.creators.length > 0
    ) {
      authors = metadata.creators
        .map((c) => {
          if (c.name) return c.name;
          const parts = [c.firstName, c.lastName].filter(Boolean);
          return parts.join(' ');
        })
        .filter(Boolean);
    }

    let year: number | string | undefined = metadata.year ?? undefined;
    if (!year && metadata.publicationDate) {
      const parsedYear = new Date(metadata.publicationDate).getFullYear();
      if (!isNaN(parsedYear)) {
        year = parsedYear;
      }
    }

    return {
      doi: metadata.doi,
      title: metadata.title || '',
      authors: authors.length > 0 ? authors : undefined,
      creators: metadata.creators?.map((c) => ({
        creatorType: c.creatorType || 'author',
        name:
          c.name || [c.firstName, c.lastName].filter(Boolean).join(' ').trim(),
        firstName: c.firstName,
        lastName: c.lastName,
      })),
      year,
      journal: metadata.journal || metadata.publicationTitle,
      publicationTitle: metadata.publicationTitle || metadata.journal,
      publicationDate: metadata.publicationDate || metadata.date,
      publisher: metadata.publisher,
      volume: metadata.volume,
      issue: metadata.issue,
      pages: metadata.pages,
      issn: metadata.issn,
      isbn: metadata.isbn,
      arxivId: metadata.arxivId,
      pmid: metadata.pmid,
      pmcid: metadata.pmcid,
      url:
        metadata.url ||
        metadata.openAccessPdfUrl ||
        (metadata.doi ? `https://doi.org/${metadata.doi}` : undefined),
      openAccessPdfUrl: metadata.openAccessPdfUrl || metadata.pdfUrl,
      abstract: metadata.abstract || metadata.abstractNote,
      citationCount: metadata.citationCount,
      keywords: normalizeTags([
        ...(metadata.keywords || []),
        ...(metadata.tags || []),
      ]),
      tags: normalizeTags([
        ...(metadata.tags || []),
        ...(metadata.keywords || []),
      ]),
      type: metadata.type || metadata.itemType || 'journal-article',
      itemType: metadata.itemType || metadata.type || 'journalArticle',
      extraFields: metadata.extraFields,
      provenance: metadata.provenance,
    };
  }

  /**
   * Intelligently resolves academic queries (DOI, arXiv ID, PMID, ISBN, URL, or title/keyword search).
   * Gracefully returns { found: false, ... } without throwing 404 exceptions on misses.
   */
  async resolveAcademicQuery(
    rawQuery: string,
    rawDoi?: string,
    workspaceId?: string,
  ): Promise<{
    found: boolean;
    work: ReferenceData | null;
    data: ReferenceData | null;
    metadata: ReferenceData | null;
    provider: string;
    queryType:
      'doi' | 'arxiv' | 'title' | 'pmid' | 'isbn' | 'url' | 'unknown' | string;
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
          workspaceId,
        });

        if (
          resolved?.metadata &&
          (resolved.metadata.title || resolved.metadata.doi)
        ) {
          const work = this.mapItemMetadataToReferenceData(resolved.metadata);
          const primaryProvider =
            resolved.provenance?.title?.provider ||
            resolved.provenance?.doi?.provider ||
            Object.values(resolved.provenance || {})[0]?.provider ||
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
      } catch (err: any) {
        this.logger.debug(
          `MetadataPort resolution failed for "${input}": ${err?.message || err}`,
        );
      }
    }

    // 2. Detect DOI pattern: e.g. 10.1000/182, https://doi.org/10..., or doi:10...
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
      // 2a. Direct CrossRef lookup
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
      } catch (err: any) {
        this.logger.debug(
          `DOI lookup miss on CrossRef for "${cleanDoiCandidate}": ${err?.message || err}. Attempting DOI Content Negotiation.`,
        );
      }

      // 2b. Direct DOI Content Negotiation (Zotero-style: DataCite/Zenodo/Figshare, mEDRA, JaLC)
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
        } catch (err: any) {
          this.logger.debug(
            `DOI Content Negotiation failed for "${cleanDoiCandidate}": ${err?.message || err}`,
          );
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

    // 3. Detect arXiv pattern: e.g. arXiv:2104.12345 or 2104.12345 or 2104.12345v1
    const arxivMatch = input.match(
      /^(?:arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})$/i,
    );
    if (arxivMatch) {
      const arxivId = arxivMatch[1].replace(/v\d+$/i, '');
      const arxivDoi = `10.48550/arXiv.${arxivId}`;
      try {
        const work = await this.resolveDoi(arxivDoi);
        return {
          found: true,
          work,
          data: work,
          metadata: work,
          provider: 'CrossRef/arXiv',
          queryType: 'arxiv',
        };
      } catch {
        // Fallback to search if arXiv DOI is not in CrossRef
      }
    }

    // 4. Title / Keyword Search via CrossRef
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
    } catch (err: any) {
      this.logger.debug(
        `CrossRef search failed for query "${input}": ${err?.message || err}`,
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
   * Formats citation directly for a stored CatalogItem by ID.
   */
  async formatItemById(
    workspaceId: string,
    itemId: string,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ) {
    const item: any = this.itemsService
      ? await this.itemsService.getItem(workspaceId, itemId)
      : await this.prisma?.catalogItem.findFirst({
          where: {
            id: itemId,
            workspaceId,
            deletedAt: null,
          },
          include: {
            contributors: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        });

    if (!item) {
      throw new NotFoundException('Paper not found in workspace');
    }

    // Tier 1: Official In-Process CSL Engine (Instant, Offline-capable, Consistent with library metadata)
    if (this.cslEngine) {
      try {
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
      } catch (err: any) {
        this.logger.warn(
          `CslEngineService format error for item ${item.id}: ${err?.message || err}. Falling back to publisher DOI.`,
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

    const citationInput: CitationItemInput = {
      id: item.id,
      title: item.title,
      itemType: item.itemType || 'journalArticle',
      authors:
        item.contributors
          ?.filter((c: any) => c.creatorType === 'author')
          .map(
            (c: any) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          ) || [],
      creators: item.contributors?.map((c: any) => ({
        firstName: c.firstName || '',
        lastName: c.lastName || '',
        name: c.fullName,
      })),
      publicationTitle: item.publicationTitle || undefined,
      journal: item.publicationTitle || undefined,
      publisher: item.publisher || undefined,
      volume: item.volume || undefined,
      issue: item.issue || undefined,
      pages: item.pages || undefined,
      year: item.year || undefined,
      doi: item.doi || undefined,
      url: item.url || undefined,
      citationKey: item.citationKey || undefined,
    };

    return this.formatItem(citationInput, styleId, index);
  }

  /**
   * Formats citations in batch for stored CatalogItems by IDs.
   */
  async formatItemBatch(
    workspaceId: string,
    itemIds: string[],
    styleId: CitationStyleId = 'apa-7th',
  ) {
    const items = this.itemsService
      ? await this.itemsService.findByIds(workspaceId, itemIds)
      : (await this.prisma?.catalogItem.findMany({
          where: {
            id: { in: itemIds },
            workspaceId,
            deletedAt: null,
          },
          include: {
            contributors: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        })) || [];

    const citationMap = new Map<string, FormattedCitationResult>();
    for (let index = 0; index < items.length; index++) {
      const item: any = items[index];
      let formatted: FormattedCitationResult | undefined;

      // Tier 1: Official In-Process CSL Engine
      if (this.cslEngine) {
        try {
          const cslItem = CslJsonMapper.toCsl(item);
          const engineRes = this.cslEngine.format(cslItem, styleId, index + 1);
          if (engineRes && engineRes.bibliography) {
            formatted = {
              styleId,
              inText: engineRes.inText,
              bibliography: engineRes.bibliography,
              bibliographyHtml: engineRes.bibliographyHtml,
              source: 'csl-engine',
            };
          }
        } catch (err: any) {
          this.logger.warn(
            `CslEngineService format error for batch item ${item.id}: ${err?.message || err}. Falling back to publisher DOI.`,
          );
        }
      }

      // Tier 2: Fallback to publisher DOI content negotiation
      if (
        !formatted &&
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
      }

      if (!formatted) {
        const citationInput: CitationItemInput = {
          id: item.id,
          title: item.title,
          itemType: item.itemType || 'journalArticle',
          authors:
            item.contributors
              ?.filter((c: any) => c.creatorType === 'author')
              .map(
                (c: any) =>
                  c.fullName ||
                  `${c.firstName || ''} ${c.lastName || ''}`.trim(),
              ) || [],
          creators: item.contributors?.map((c: any) => ({
            firstName: c.firstName || '',
            lastName: c.lastName || '',
            name: c.fullName,
          })),
          publicationTitle: item.publicationTitle || undefined,
          journal: item.publicationTitle || undefined,
          publisher: item.publisher || undefined,
          volume: item.volume || undefined,
          issue: item.issue || undefined,
          pages: item.pages || undefined,
          year: item.year || undefined,
          doi: item.doi || undefined,
          url: item.url || undefined,
          citationKey: item.citationKey || undefined,
        };
        formatted = this.formatItem(citationInput, styleId, index + 1);
      }

      citationMap.set(item.id, formatted);
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
      citations,
    };
  }

  private mapCrossRefMessage(message: any): ReferenceData {
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
