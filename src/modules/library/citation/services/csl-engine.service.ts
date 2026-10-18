import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import {
  CslItemData,
  CslName,
} from '@/modules/library/citation/types/csl-json.types';
import { CslRepositoryService } from './csl-repository.service';
import {
  CslLocaleLoaderService,
  BUILTIN_SPECIAL_STYLES,
  NUMERIC_STYLE_TOKENS,
} from './csl-locale-loader.service';
import {
  CslStyleFormatterService,
  BIBTEX_ITEM_TYPE_MAP,
  BIBTEX_CSL_TYPE_MAP,
  RIS_ITEM_TYPE_MAP,
  RIS_CSL_TYPE_MAP,
} from './csl-style-formatter.service';

interface CiteInstance {
  format(
    type: string,
    options?: {
      template?: string;
      lang?: string;
      format?: string;
      entry?: string;
    },
  ): string;
}

interface CiteConstructor {
  new (data: unknown): CiteInstance;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core') as { Cite: CiteConstructor };

export interface EngineCitationResult {
  styleId: string;
  inText: string;
  bibliography: string;
  bibliographyHtml?: string;
  source: 'csl-engine';
}

export {
  CslLocaleLoaderService,
  CslStyleFormatterService,
  BUILTIN_SPECIAL_STYLES,
  NUMERIC_STYLE_TOKENS,
  BIBTEX_ITEM_TYPE_MAP,
  BIBTEX_CSL_TYPE_MAP,
  RIS_ITEM_TYPE_MAP,
  RIS_CSL_TYPE_MAP,
};

@Injectable()
export class CslEngineService implements OnModuleInit {
  private readonly logger = new Logger(CslEngineService.name);
  private readonly citationCache = new Map<string, EngineCitationResult>();
  private readonly maxCacheEntries = 2000;
  private readonly loader: CslLocaleLoaderService;
  private readonly formatter: CslStyleFormatterService;

  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
    @Optional()
    loader?: CslLocaleLoaderService,
    @Optional()
    formatter?: CslStyleFormatterService,
  ) {
    this.loader = loader ?? new CslLocaleLoaderService(this.cslRepo);
    this.formatter = formatter ?? new CslStyleFormatterService();
  }

  private getCacheKey(
    cslItem: CslItemData,
    style: string,
    index?: number,
  ): string {
    const rawId =
      (typeof cslItem._itemId === 'string' ? cslItem._itemId : '') ||
      cslItem.id ||
      cslItem.DOI ||
      cslItem.title ||
      '';
    const date = cslItem.issued?.['date-parts']?.[0]?.[0] || '';
    const ver =
      cslItem.version ||
      (typeof cslItem._version === 'string' ? cslItem._version : '') ||
      '';
    const updated =
      typeof cslItem._updatedAt === 'string' ||
      typeof cslItem._updatedAt === 'number'
        ? String(cslItem._updatedAt)
        : '';
    return `${rawId}::${style}::${date}::${ver}::${updated}${index !== undefined ? `::${index}` : ''}`;
  }

  private setCache(
    key: string,
    result: EngineCitationResult,
  ): EngineCitationResult {
    if (this.citationCache.size >= this.maxCacheEntries) {
      const oldestKey = this.citationCache.keys().next().value;
      if (oldestKey) this.citationCache.delete(oldestKey);
    }
    this.citationCache.set(key, result);
    return result;
  }

  onModuleInit() {
    this.initTemplates();
  }

  public isStyleSupported(styleId: string): boolean {
    return this.loader.isStyleSupported(styleId);
  }

  public async ensureTemplate(styleId: string): Promise<boolean> {
    return this.loader.ensureTemplate(styleId);
  }

  public initTemplates(): void {
    this.loader.initTemplates();
  }

  public normalizeStyle(styleId: string): string {
    return this.loader.normalizeStyle(styleId);
  }

  public async formatAsync(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
  ): Promise<EngineCitationResult> {
    await this.ensureTemplate(styleId);
    return this.format(cslItem, styleId, index);
  }

  public async formatBatchAsync(
    cslItems: CslItemData[],
    styleId: string = 'apa',
  ) {
    await this.ensureTemplate(styleId);
    return this.formatBatch(cslItems, styleId);
  }

  public format(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
  ): EngineCitationResult {
    this.initTemplates();
    const normalizedStyle = this.normalizeStyle(styleId);

    const cacheKey = this.getCacheKey(cslItem, normalizedStyle, index);
    const cached = this.citationCache.get(cacheKey);
    if (cached) {
      this.citationCache.delete(cacheKey);
      this.citationCache.set(cacheKey, cached);
      return cached;
    }

    if (normalizedStyle === 'auto' || normalizedStyle === 'auto-numeric') {
      const isVn = CslEngineService.isVietnameseItem(cslItem);
      const targetStyle =
        normalizedStyle === 'auto-numeric'
          ? isVn
            ? 'tcvn-numeric'
            : 'ieee'
          : isVn
            ? 'tcvn'
            : 'apa';
      const result = this.format(cslItem, targetStyle, index);
      return this.setCache(cacheKey, { ...result, styleId: normalizedStyle });
    }

    if (normalizedStyle === 'bibtex' || normalizedStyle === 'ris') {
      const isBib = normalizedStyle === 'bibtex';
      const rawText = isBib
        ? this.formatter.formatBibtex(cslItem)
        : this.formatter.formatRis(cslItem);
      return this.setCache(cacheKey, {
        styleId: normalizedStyle,
        inText: isBib ? `\\cite{${cslItem.id}}` : cslItem.title,
        bibliography: rawText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.formatter.escapeHtml(rawText)}</pre>`,
        source: 'csl-engine',
      });
    }

    if (normalizedStyle === 'tcvn' || normalizedStyle === 'tcvn-numeric') {
      return this.setCache(
        cacheKey,
        this.formatter.formatTcvn(
          cslItem,
          normalizedStyle === 'tcvn-numeric',
          index,
        ),
      );
    }

    try {
      const cite = new Cite(cslItem);
      let bibliography = cite
        .format('bibliography', { template: normalizedStyle, lang: 'en-US' })
        .trim();
      if (normalizedStyle === 'ieee') {
        bibliography = bibliography.replace(/[\u201C\u201D]/g, '"');
      }

      const bibliographyHtml = cite
        .format('bibliography', {
          template: normalizedStyle,
          lang: 'en-US',
          format: 'html',
        })
        .trim();

      let inText = '';
      try {
        inText = cite
          .format('citation', {
            template: normalizedStyle,
            lang: 'en-US',
            entry: cslItem.id,
          })
          .trim();
      } catch {
        inText = `(${cslItem.author?.[0]?.family || 'Anonymous'}, ${cslItem.issued?.['date-parts']?.[0]?.[0] || 'n.d.'})`;
      }

      return this.setCache(cacheKey, {
        styleId: normalizedStyle,
        inText,
        bibliography,
        bibliographyHtml,
        source: 'csl-engine',
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to render CSL template ${normalizedStyle}: ${errMsg}. Falling back to smart formatter.`,
      );

      const authors = cslItem.author || [];
      const firstAuthorFamily =
        authors[0]?.family || authors[0]?.literal || 'Anonymous';
      const authorListStr =
        authors.length > 0
          ? authors
              .map((a: CslName) =>
                `${a.family || a.literal || ''} ${a.given ? a.given[0] + '.' : ''}`.trim(),
              )
              .filter(Boolean)
              .join(', ')
          : 'Anonymous';
      const year = cslItem.issued?.['date-parts']?.[0]?.[0] || 'n.d.';
      const title = cslItem.title || 'Untitled Item';
      const journal = cslItem['container-title'] || '';
      const volume = cslItem.volume ? ` ${cslItem.volume}` : '';
      const issue = cslItem.issue ? `(${cslItem.issue})` : '';
      const page = cslItem.page ? `: ${cslItem.page}` : '';

      if (NUMERIC_STYLE_TOKENS.some((s) => normalizedStyle.includes(s))) {
        return this.setCache(cacheKey, {
          styleId: normalizedStyle,
          inText: `[${index}]`,
          bibliography: `[${index}] ${authorListStr}. ${title}.${journal ? ` ${journal}.` : ''} ${year}${volume}${issue}${page}.`,
          bibliographyHtml: `[${index}] ${authorListStr}. ${title}.${journal ? ` <i>${journal}</i>.` : ''} ${year}${volume}${issue}${page}.`,
          source: 'csl-engine',
        });
      }

      if (normalizedStyle.includes('harvard')) {
        return this.setCache(cacheKey, {
          styleId: normalizedStyle,
          inText: `(${firstAuthorFamily}, ${year})`,
          bibliography: `${authorListStr} (${year}) '${title}', ${journal}${volume}${issue}${cslItem.page ? `, pp. ${cslItem.page}` : ''}.`,
          bibliographyHtml: `${authorListStr} (${year}) &lsquo;${title}&rsquo;, <i>${journal}</i>${volume}${issue}${cslItem.page ? `, pp. ${cslItem.page}` : ''}.`,
          source: 'csl-engine',
        });
      }

      const cite = new Cite(cslItem);
      return this.setCache(cacheKey, {
        styleId: normalizedStyle,
        inText: cite
          .format('citation', {
            template: 'apa',
            lang: 'en-US',
            entry: cslItem.id,
          })
          .trim(),
        bibliography: cite
          .format('bibliography', { template: 'apa', lang: 'en-US' })
          .trim(),
        bibliographyHtml: cite
          .format('bibliography', {
            template: 'apa',
            lang: 'en-US',
            format: 'html',
          })
          .trim(),
        source: 'csl-engine',
      });
    }
  }

  public formatBatch(
    cslItems: CslItemData[],
    styleId: string = 'apa',
  ): {
    styleId: string;
    combinedInText: string;
    bibliographyText: string;
    bibliographyHtml: string;
    citations: Array<{
      id: string;
      inText: string;
      bibliography: string;
      bibliographyHtml?: string;
    }>;
  } {
    this.initTemplates();
    const normalizedStyle = this.normalizeStyle(styleId);

    if (cslItems.length === 0) {
      return {
        styleId: normalizedStyle,
        combinedInText: '',
        citations: [],
        bibliographyText: '',
        bibliographyHtml: '',
      };
    }

    if (normalizedStyle === 'bibtex' || normalizedStyle === 'ris') {
      const isBib = normalizedStyle === 'bibtex';
      const renderedList = cslItems.map((item) =>
        isBib
          ? this.formatter.formatBibtex(item)
          : this.formatter.formatRis(item),
      );
      const bibliographyText = renderedList.join('\n\n');
      return {
        styleId: normalizedStyle,
        combinedInText: isBib
          ? `\\cite{${cslItems.map((item) => item.id).join(', ')}}`
          : cslItems.map((item) => item.title).join('; '),
        citations: cslItems.map((item, idx) => ({
          id: item.id,
          inText: isBib ? `\\cite{${item.id}}` : item.title,
          bibliography: renderedList[idx],
          bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.formatter.escapeHtml(renderedList[idx])}</pre>`,
        })),
        bibliographyText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.formatter.escapeHtml(bibliographyText)}</pre>`,
      };
    }

    if (normalizedStyle === 'auto' || normalizedStyle === 'auto-numeric') {
      const hasVn = cslItems.some((item) =>
        CslEngineService.isVietnameseItem(item),
      );
      const targetStyle =
        normalizedStyle === 'auto-numeric'
          ? hasVn
            ? 'tcvn-numeric'
            : 'ieee'
          : hasVn
            ? 'tcvn'
            : 'apa';
      return {
        ...this.formatBatch(cslItems, targetStyle),
        styleId: normalizedStyle,
      };
    }

    if (normalizedStyle === 'tcvn' || normalizedStyle === 'tcvn-numeric') {
      return this.formatter.formatTcvnBatch(
        cslItems,
        normalizedStyle === 'tcvn-numeric',
      );
    }

    const citations = cslItems.map((item, idx) => {
      const single = this.format(item, normalizedStyle, idx + 1);
      return {
        id: item.id,
        inText: single.inText,
        bibliography: single.bibliography,
        bibliographyHtml: single.bibliographyHtml,
      };
    });

    const buildFallbackCombinedInText = () => {
      const isNumeric = NUMERIC_STYLE_TOKENS.some((s) =>
        normalizedStyle.includes(s),
      );
      if (isNumeric) {
        return `[${cslItems.map((_, i) => i + 1).join(', ')}]`;
      }
      const inTexts = citations
        .map((c) => c.inText.replace(/^\(|\)$/g, ''))
        .filter(Boolean);
      return `(${inTexts.join('; ')})`;
    };

    try {
      const cite = new Cite(cslItems);
      const bibliographyText = cite
        .format('bibliography', { template: normalizedStyle, lang: 'en-US' })
        .trim();
      const bibliographyHtml = cite
        .format('bibliography', {
          template: normalizedStyle,
          lang: 'en-US',
          format: 'html',
        })
        .trim();

      let combinedInText = '';
      try {
        combinedInText = cite
          .format('citation', { template: normalizedStyle, lang: 'en-US' })
          .trim();
      } catch {
        combinedInText = buildFallbackCombinedInText();
      }

      return {
        styleId: normalizedStyle,
        combinedInText,
        citations,
        bibliographyText,
        bibliographyHtml,
      };
    } catch {
      return {
        styleId: normalizedStyle,
        combinedInText: buildFallbackCombinedInText(),
        citations,
        bibliographyText: citations.map((c) => c.bibliography).join('\n\n'),
        bibliographyHtml: '',
      };
    }
  }

  public formatBibtex(cslInput: CslItemData | CslItemData[]): string {
    return this.formatter.formatBibtex(cslInput);
  }

  public formatRis(cslInput: CslItemData | CslItemData[]): string {
    return this.formatter.formatRis(cslInput);
  }

  public formatTcvn(
    cslItem: CslItemData,
    isNumeric: boolean = false,
    index: number = 1,
  ): EngineCitationResult {
    return this.formatter.formatTcvn(cslItem, isNumeric, index);
  }

  public formatTcvnBatch(cslItems: CslItemData[], isNumeric: boolean = false) {
    return this.formatter.formatTcvnBatch(cslItems, isNumeric);
  }

  public static isVietnameseAuthor(author?: CslName | null): boolean {
    return CslStyleFormatterService.isVietnameseAuthor(author);
  }

  public static getVietnameseSortKey(author?: CslName | null): {
    primary: string;
    secondary: string;
  } {
    return CslStyleFormatterService.getVietnameseSortKey(author);
  }

  public static isVietnameseItem(item: CslItemData): boolean {
    return CslStyleFormatterService.isVietnameseItem(item);
  }

  public static compareTcvnEntries(
    itemA: CslItemData,
    itemB: CslItemData,
  ): number {
    return CslStyleFormatterService.compareTcvnEntries(itemA, itemB);
  }

  public static formatTcvnAuthorName(author?: CslName | null): string {
    return CslStyleFormatterService.formatTcvnAuthorName(author);
  }

  public static formatTcvnInTextAuthor(author?: CslName | null): string {
    return CslStyleFormatterService.formatTcvnInTextAuthor(author);
  }
}
