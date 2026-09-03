import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { CslStyleRegistry } from './formatters/csl-style-registry';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
} from './types/citation.types';
import { CatalogRepository } from '../catalog/catalog.repository';
import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import { CslEngineService } from './services/csl-engine.service';
import { CslJsonMapper } from './mappers/csl-json.mapper';

export interface ReferenceData {
  doi?: string;
  title: string;
  authors?: string[];
  year?: number | string;
  journal?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  abstract?: string;
  type?: string;
  itemType?: string;
  score?: number;
}

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);
  private readonly registry = new CslStyleRegistry();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly catalogRepo?: CatalogRepository,
    @Optional() private readonly doiService?: DoiContentNegotiationService,
    @Optional() private readonly cslEngine?: CslEngineService,
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://api.crossref.org/works/${encodeURIComponent(clean)}`,
        {
          headers: { Accept: 'application/json' },
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://api.crossref.org/works?query=${encodeURIComponent(query.trim())}&rows=${rows}`,
        {
          headers: { Accept: 'application/json' },
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

  /**
   * Formats citation directly for a stored CatalogItem by ID.
   */
  async formatItemById(
    workspaceId: string,
    itemId: string,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ) {
    const item = this.catalogRepo
      ? await this.catalogRepo.findById(workspaceId, itemId)
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
    const items = this.catalogRepo
      ? await this.catalogRepo.findByIds(workspaceId, itemIds)
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
      const item = items[index];
      let formatted: FormattedCitationResult | null = null;

      // Tier 1: Official In-Process CSL Engine
      if (this.cslEngine) {
        try {
          const engineRes = this.cslEngine.format(
            CslJsonMapper.toCsl(item),
            styleId,
            index + 1,
          );
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
            `Batch CSL format error for item ${item.id}: ${err?.message || err}`,
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
            inText: doiCitation.inText || `[${index + 1}]`,
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
              ?.filter((c) => c.creatorType === 'author')
              .map(
                (c) =>
                  c.fullName ||
                  `${c.firstName || ''} ${c.lastName || ''}`.trim(),
              ) || [],
          creators: item.contributors?.map((c) => ({
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
