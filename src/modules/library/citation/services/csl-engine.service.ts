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
  CitationContextOptions,
  EngineCitationResult,
} from '@/modules/library/citation/types/citation.types';
import {
  CslRepositoryService,
  CslLocaleLoaderService,
} from './csl-repository.service';
import {
  BUILTIN_SPECIAL_STYLES,
  NUMERIC_STYLE_TOKENS,
} from '@/modules/library/citation/domain/citation.domain';
import {
  CslStyleFormatterService,
  BIBTEX_ITEM_TYPE_MAP,
  BIBTEX_CSL_TYPE_MAP,
  RIS_ITEM_TYPE_MAP,
  RIS_CSL_TYPE_MAP,
} from './csl-style-formatter.service';
import { TcvnCitationFormatterService } from '@/modules/library/citation/domain/tcvn-citation.domain';

interface CiteEntryOption {
  id: string;
  locator?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  'suppress-author'?: boolean;
}

interface CiteInstance {
  format(
    type: string,
    options?: {
      template?: string;
      lang?: string;
      format?: string;
      entry?: string | Array<string | CiteEntryOption>;
    },
  ): string;
}

interface CiteConstructor {
  new (data: unknown): CiteInstance;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core') as { Cite: CiteConstructor };

export type { EngineCitationResult };

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
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly EVENT_LOOP_YIELD_BATCH_SIZE = 25;
  private readonly citationCache = new Map<
    string,
    { result: EngineCitationResult; expiresAt: number }
  >();
  private readonly cslItemFingerprintCache = new WeakMap<object, string>();
  private readonly maxCacheEntries = 2000;
  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
    @Optional()
    private readonly loader: CslLocaleLoaderService = new CslLocaleLoaderService(
      this.cslRepo,
    ),
    @Optional()
    private readonly formatter: CslStyleFormatterService = new CslStyleFormatterService(),
  ) {}

  private getOrComputeContentFingerprint(cslItem: CslItemData): string {
    if (cslItem && typeof cslItem === 'object') {
      const cached = this.cslItemFingerprintCache.get(cslItem);
      if (cached !== undefined) {
        return cached;
      }
    }

    const formatDateSig = (d?: {
      'date-parts'?: Array<Array<number | string>>;
      literal?: string;
      raw?: string;
      circa?: boolean | string | number;
      season?: number | string;
    }) => {
      if (!d) return '';
      const dp = Array.isArray(d['date-parts'])
        ? d['date-parts']
            .map((p) => (Array.isArray(p) ? p.join('-') : ''))
            .join('/')
        : '';
      return `${dp}:${d.literal || ''}:${d.raw || ''}:${d.season ?? ''}:${d.circa ? 'c' : ''}`;
    };
    const date = formatDateSig(cslItem.issued);
    const accessed = formatDateSig(cslItem.accessed);
    const submitted = formatDateSig(cslItem.submitted);
    const ver =
      cslItem.version ||
      (typeof cslItem._version === 'string' ? cslItem._version : '') ||
      '';
    const updated =
      typeof cslItem._updatedAt === 'string' ||
      typeof cslItem._updatedAt === 'number'
        ? String(cslItem._updatedAt)
        : '';
    const formatNamesSig = (list?: CslName[]) =>
      Array.isArray(list) && list.length > 0
        ? list
            .map(
              (n) =>
                `${n.family || ''}:${n.given || ''}:${n.literal || ''}:${n.suffix || ''}`,
            )
            .join(';')
        : '';
    const authorSig = formatNamesSig(cslItem.author);
    const editorSig = formatNamesSig(cslItem.editor);
    const translatorSig = formatNamesSig(cslItem.translator);
    const rec = cslItem as Record<string, unknown>;
    const extendedCreatorSigs = (
      ['director', 'composer', 'interviewer', 'recipient', 'reviewed-author', 'collection-editor', 'container-author', 'contributor'] as const
    ).map((role) => formatNamesSig(rec[role] as CslName[] | undefined)).join('|');
    const contentFingerprint = [
      cslItem.type || '', cslItem.title || '', cslItem['title-short'] || '',
      authorSig, editorSig, translatorSig, extendedCreatorSigs,
      cslItem['container-title'] || '', cslItem['container-title-short'] || '',
      cslItem['collection-title'] || '', cslItem['collection-number'] ?? '',
      cslItem.volume ?? '', cslItem['number-of-volumes'] ?? '', cslItem.issue ?? '',
      cslItem.number ?? '', cslItem.edition ?? '', cslItem.page || '',
      cslItem['number-of-pages'] ?? '', cslItem.section || '',
      String(rec['chapter-number'] ?? rec.chapter ?? ''),
      cslItem.DOI || '', cslItem.ISBN || '', cslItem.ISSN || '', cslItem.URL || '',
      accessed, submitted, cslItem.publisher || '', cslItem['publisher-place'] || '',
      cslItem.genre || '', cslItem.medium || String(rec.medium ?? ''),
      cslItem.status || '', cslItem.version || '', cslItem.language || '',
      cslItem.abstract || '', cslItem.keyword || '', cslItem.note || '',
      cslItem.annote || '', cslItem.PMID || '', cslItem.PMCID || '',
      cslItem['event-title'] || '', cslItem['event-place'] || '', cslItem.authority || '',
      cslItem.archive || '', cslItem['archive-location'] || cslItem.archive_location || '',
      cslItem['call-number'] || '', cslItem.rights || '',
    ].join('|');

    const fullDigest = `${date}::${ver}::${updated}::${contentFingerprint}`;
    if (cslItem && typeof cslItem === 'object') {
      this.cslItemFingerprintCache.set(cslItem, fullDigest);
    }
    return fullDigest;
  }

  public buildCacheKey(
    cslItem: CslItemData,
    style: string,
    index?: number,
    context?: CitationContextOptions,
  ): string {
    const rawId =
      (typeof cslItem._itemId === 'string' ? cslItem._itemId : '') ||
      cslItem.id ||
      cslItem.DOI ||
      cslItem.title ||
      '';
    const digest = this.getOrComputeContentFingerprint(cslItem);
    const tplDigest =
      typeof this.loader?.getTemplateDigest === 'function'
        ? this.loader.getTemplateDigest(style)
        : '';
    const ctxSig = context
      ? `::${context.locator || ''}:${context.label || ''}:${context.prefix || ''}:${context.suffix || ''}:${context.suppressAuthor ? '1' : '0'}:${context.locale || ''}`
      : '';
    return `${rawId}::${style}${tplDigest ? `@${tplDigest}` : ''}::${digest}${index !== undefined ? `::${index}` : ''}${ctxSig}`;
  }

  private getCacheKey(
    cslItem: CslItemData,
    style: string,
    index?: number,
    context?: CitationContextOptions,
  ): string {
    return this.buildCacheKey(cslItem, style, index, context);
  }

  private getCached(key: string): EngineCitationResult | null {
    const entry = this.citationCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.citationCache.delete(key);
      return null;
    }
    this.citationCache.delete(key);
    this.citationCache.set(key, entry);
    return entry.result;
  }

  private setCache(
    key: string,
    result: EngineCitationResult,
  ): EngineCitationResult {
    const now = Date.now();
    if (this.citationCache.size >= this.maxCacheEntries) {
      for (const [k, v] of this.citationCache.entries()) {
        if (now > v.expiresAt) {
          this.citationCache.delete(k);
        }
      }
      if (this.citationCache.size >= this.maxCacheEntries) {
        const oldestKey = this.citationCache.keys().next().value;
        if (oldestKey) this.citationCache.delete(oldestKey);
      }
    }
    this.citationCache.set(key, {
      result,
      expiresAt: now + CslEngineService.CACHE_TTL_MS,
    });
    return result;
  }

  onModuleInit() {
    this.initTemplates();
  }

  public isStyleSupported(styleId: string): boolean {
    return this.loader.isStyleSupported(styleId);
  }

  public async ensureTemplate(
    styleId: string,
    scopeId?: string,
    rawXml?: string,
  ): Promise<boolean> {
    return this.loader.ensureTemplate(styleId, scopeId, rawXml);
  }

  public initTemplates(): void {
    this.loader.initTemplates();
  }

  public normalizeStyle(styleId: string): string {
    return this.loader.normalizeStyle(styleId);
  }


  public async formatBatchAsync(
    cslItems: CslItemData[],
    styleId: string = 'apa',
    scopeId?: string,
  ) {
    await this.ensureTemplate(styleId, scopeId);
    const normalizedStyle = this.normalizeStyle(styleId);
    if (
      cslItems.length === 0 ||
      normalizedStyle === 'bibtex' ||
      normalizedStyle === 'ris' ||
      normalizedStyle === 'tcvn' ||
      normalizedStyle === 'tcvn-numeric' ||
      normalizedStyle === 'auto' ||
      normalizedStyle === 'auto-numeric'
    ) {
      return this.formatBatch(cslItems, styleId);
    }

    // Yield to the event loop once before multi-item CSL rendering for large batches,
    // then delegate directly to formatBatch(cslItems, styleId, undefined, scopeId) so
    // `new Cite(cslItems)` runs as a true multi-item CSL processor (preserving CSL
    // bibliography `<sort>`, numeric range collapsing `[1]-[3]`, and native disambiguation).
    if (cslItems.length >= CslEngineService.EVENT_LOOP_YIELD_BATCH_SIZE) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    return this.formatBatch(cslItems, styleId, undefined, scopeId);
  }

  private buildCiteEntryParam(
    entryId: string,
    context?: CitationContextOptions,
  ): string | Array<CiteEntryOption> {
    if (
      !context ||
      (!context.locator &&
        !context.prefix &&
        !context.suffix &&
        !context.suppressAuthor)
    ) {
      return entryId;
    }
    return [
      {
        id: entryId,
        ...(context.locator
          ? {
              locator: context.locator.trim(),
              label: context.label?.trim() || 'page',
            }
          : {}),
        ...(context.prefix ? { prefix: context.prefix } : {}),
        ...(context.suffix ? { suffix: context.suffix } : {}),
        ...(context.suppressAuthor ? { 'suppress-author': true } : {}),
      },
    ];
  }

  public format(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
    scopeId?: string,
    context?: CitationContextOptions,
  ): EngineCitationResult {
    this.initTemplates();
    const normalizedStyle = this.loader.getScopedStyleId(styleId, scopeId);

    const cacheKey = this.getCacheKey(cslItem, normalizedStyle, index, context);
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    if (normalizedStyle === 'auto' || normalizedStyle === 'auto-numeric') {
      const isVn = TcvnCitationFormatterService.isVietnameseItem(cslItem);
      const targetStyle =
        normalizedStyle === 'auto-numeric'
          ? isVn
            ? 'tcvn-numeric'
            : 'ieee'
          : isVn
            ? 'tcvn'
            : 'apa';
      const result = this.format(cslItem, targetStyle, index, scopeId, context);
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
      const tcvnRes = this.formatter.formatTcvn(
        cslItem,
        normalizedStyle === 'tcvn-numeric',
        index,
      );
      if (context?.locator) {
        const locPrefix =
          !context.label || context.label === 'page' ? 'tr. ' : `${context.label} `;
        tcvnRes.inText = tcvnRes.inText.replace(
          /([)\]])$/,
          `, ${locPrefix}${context.locator.trim()}$1`,
        );
      }
      return this.setCache(cacheKey, tcvnRes);
    }

    const effectiveLang =
      context?.locale?.trim() ||
      this.loader.getStyleDefaultLocale(styleId, scopeId);

    const cite = new Cite(cslItem);
    const activeTemplate = this.loader.isStyleSupported(styleId, scopeId)
      ? normalizedStyle
      : 'apa';
    let bibliography = cite
      .format('bibliography', { template: activeTemplate, lang: effectiveLang })
      .trim();
    if (normalizedStyle === 'ieee') {
      bibliography = bibliography.replace(/[\u201C\u201D]/g, '"');
    }

    const bibliographyHtml = cite
      .format('bibliography', {
        template: activeTemplate,
        lang: effectiveLang,
        format: 'html',
      })
      .trim();

    const inText = cite
      .format('citation', {
        template: activeTemplate,
        lang: effectiveLang,
        entry: this.buildCiteEntryParam(cslItem.id, context),
      })
      .trim();

    return this.setCache(cacheKey, {
      styleId: normalizedStyle,
      inText,
      bibliography,
      bibliographyHtml,
      source: 'csl-engine',
    });
  }

  public formatBatch(
    cslItems: CslItemData[],
    styleId: string = 'apa',
    _unused?: undefined,
    scopeId?: string,
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
    const baseStyle = this.normalizeStyle(styleId);
    const normalizedStyle = this.loader.getScopedStyleId(styleId, scopeId);

    if (cslItems.length === 0) {
      return {
        styleId: baseStyle,
        combinedInText: '',
        citations: [],
        bibliographyText: '',
        bibliographyHtml: '',
      };
    }

    if (baseStyle === 'bibtex' || baseStyle === 'ris') {
      const isBib = baseStyle === 'bibtex';
      const renderedList = cslItems.map((item) =>
        isBib
          ? this.formatter.formatBibtex(item)
          : this.formatter.formatRis(item),
      );
      const bibliographyText = renderedList.join('\n\n');
      return {
        styleId: baseStyle,
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

    if (baseStyle === 'auto' || baseStyle === 'auto-numeric') {
      const hasVn = cslItems.some((item) =>
        TcvnCitationFormatterService.isVietnameseItem(item),
      );
      const targetStyle =
        baseStyle === 'auto-numeric'
          ? hasVn
            ? 'tcvn-numeric'
            : 'ieee'
          : hasVn
            ? 'tcvn'
            : 'apa';
      return {
        ...this.formatBatch(cslItems, targetStyle, undefined, scopeId),
        styleId: baseStyle,
      };
    }

    if (baseStyle === 'tcvn' || baseStyle === 'tcvn-numeric') {
      return this.formatter.formatTcvnBatch(
        cslItems,
        baseStyle === 'tcvn-numeric',
      );
    }

    const isNumericStyle = NUMERIC_STYLE_TOKENS.some((s) => baseStyle.includes(s));
    const applyBatchYearDisambiguation = (
      list: Array<{ id: string; inText: string; bibliography: string; bibliographyHtml?: string }>,
    ) => {
      if (isNumericStyle || cslItems.length < 2) return list;
      const groups = new Map<string, number[]>();
      list.forEach((entry, idx) => {
        const item = cslItems[idx];
        const yearRaw = item?.issued?.['date-parts']?.[0]?.[0];
        const yearStr = yearRaw !== undefined && yearRaw !== null ? String(yearRaw).trim() : '';
        if (!/^\d{4}$/.test(yearStr)) return;
        const normalizedInText = (entry.inText || '').replace(/^\(|\)$/g, '').trim().toLowerCase();
        if (!normalizedInText) return;
        const key = `${normalizedInText}::${yearStr}`;
        const arr = groups.get(key) ?? [];
        arr.push(idx);
        groups.set(key, arr);
      });

      const cloned = list.map((c) => ({ ...c }));
      for (const [key, indices] of groups.entries()) {
        if (indices.length < 2) continue;
        const yearStr = key.split('::').pop()!;
        indices.forEach((itemIdx, pos) => {
          const suffix = String.fromCharCode(97 + (pos % 26));
          const suffixedYear = `${yearStr}${suffix}`;
          const entry = cloned[itemIdx];
          if (!entry) return;
          const alreadyHasSuffixRe = new RegExp(`\\b${yearStr}[a-z]\\b`);
          if (!alreadyHasSuffixRe.test(entry.inText)) {
            entry.inText = entry.inText.replace(new RegExp(`\\b${yearStr}\\b`), suffixedYear);
          }
          if (!alreadyHasSuffixRe.test(entry.bibliography)) {
            const parenYearRe = new RegExp(`(\\(\\s*${yearStr})(\\s*[,)])`);
            if (parenYearRe.test(entry.bibliography)) {
              entry.bibliography = entry.bibliography.replace(parenYearRe, `$1${suffix}$2`);
            } else {
              entry.bibliography = entry.bibliography.replace(
                new RegExp(`(\\b${yearStr})\\b`),
                `$1${suffix}`,
              );
            }
          }
          if (entry.bibliographyHtml && !alreadyHasSuffixRe.test(entry.bibliographyHtml)) {
            const parenYearRe = new RegExp(`(\\(\\s*${yearStr})(\\s*[,)])`);
            if (parenYearRe.test(entry.bibliographyHtml)) {
              entry.bibliographyHtml = entry.bibliographyHtml.replace(
                parenYearRe,
                `$1${suffix}$2`,
              );
            } else {
              entry.bibliographyHtml = entry.bibliographyHtml.replace(
                new RegExp(`(\\b${yearStr})\\b`),
                `$1${suffix}`,
              );
            }
          }
        });
      }
      return cloned;
    };

    const effectiveLang = this.loader.getStyleDefaultLocale(styleId, scopeId);
    const activeTemplate = this.loader.isStyleSupported(styleId, scopeId)
      ? normalizedStyle
      : 'apa';
    const cite = new Cite(cslItems);
    let bibliographyText = cite
      .format('bibliography', { template: activeTemplate, lang: effectiveLang })
      .trim();
    if (baseStyle === 'ieee') {
      bibliographyText = bibliographyText.replace(/[\u201C\u201D]/g, '"');
    }
    const bibliographyHtml = cite
      .format('bibliography', {
        template: activeTemplate,
        lang: effectiveLang,
        format: 'html',
      })
      .trim();

    const batchCitations = applyBatchYearDisambiguation(
      cslItems.map((item, idx) => {
        const cacheIndex = isNumericStyle ? idx + 1 : undefined;
        const cacheKey = this.buildCacheKey(item, activeTemplate, cacheIndex);
        const cached = this.getCached(cacheKey);
        if (cached) {
          return {
            id: item.id,
            inText: cached.inText,
            bibliography: cached.bibliography,
            bibliographyHtml: cached.bibliographyHtml,
          };
        }

        const rawCit = cite
          .format('citation', {
            template: activeTemplate,
            lang: effectiveLang,
            entry: item.id,
          })
          .trim();
        const rawBib = cite
          .format('bibliography', {
            template: activeTemplate,
            lang: effectiveLang,
            entry: item.id,
          })
          .trim();
        const bibHtml = cite
          .format('bibliography', {
            template: activeTemplate,
            lang: effectiveLang,
            format: 'html',
            entry: item.id,
          })
          .trim();
        let itemBib =
          baseStyle === 'ieee' ? rawBib.replace(/[\u201C\u201D]/g, '"') : rawBib;
        let cit = rawCit;
        if (isNumericStyle && idx > 0) {
          const numStr = String(idx + 1);
          if (cit === '[1]') cit = `[${numStr}]`;
          else if (cit === '(1)') cit = `(${numStr})`;
          else if (cit === '1') cit = numStr;
          if (/^\[1\]\s/.test(itemBib)) {
            itemBib = itemBib.replace(/^\[1\](\s)/, `[${numStr}]$1`);
          } else if (/^1\.\s/.test(itemBib)) {
            itemBib = itemBib.replace(/^1\.(\s)/, `${numStr}.$1`);
          }
        }
        const entryResult = {
          id: item.id,
          inText: cit,
          bibliography: itemBib,
          bibliographyHtml: bibHtml,
        };
        this.setCache(cacheKey, {
          styleId: baseStyle,
          inText: cit,
          bibliography: itemBib,
          bibliographyHtml: bibHtml,
          source: 'csl-engine',
        });
        return entryResult;
      }),
    );

    const combinedInText = cite
      .format('citation', { template: activeTemplate, lang: effectiveLang })
      .trim();

    return {
      styleId: baseStyle,
      combinedInText,
      citations: batchCitations,
      bibliographyText,
      bibliographyHtml,
    };
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
}
