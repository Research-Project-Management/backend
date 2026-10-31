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
} from '@/modules/library/citation/types/citation.types';
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
import { TcvnCitationFormatterService } from './tcvn-citation-formatter.service';

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
  ): string {
    const rawId =
      (typeof cslItem._itemId === 'string' ? cslItem._itemId : '') ||
      cslItem.id ||
      cslItem.DOI ||
      cslItem.title ||
      '';
    const digest = this.getOrComputeContentFingerprint(cslItem);
    return `${rawId}::${style}::${digest}${index !== undefined ? `::${index}` : ''}`;
  }

  private getCacheKey(
    cslItem: CslItemData,
    style: string,
    index?: number,
  ): string {
    return this.buildCacheKey(cslItem, style, index);
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

  public async formatAsync(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
    scopeId?: string,
  ): Promise<EngineCitationResult> {
    await this.ensureTemplate(styleId, scopeId);
    return this.format(cslItem, styleId, index);
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

    const preformattedCitations: Array<{
      id: string;
      inText: string;
      bibliography: string;
      bibliographyHtml?: string;
    }> = [];

    for (let i = 0; i < cslItems.length; i++) {
      if (
        i > 0 &&
        i % CslEngineService.EVENT_LOOP_YIELD_BATCH_SIZE === 0
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const single = this.format(cslItems[i], normalizedStyle, i + 1);
      preformattedCitations.push({
        id: cslItems[i].id,
        inText: single.inText,
        bibliography: single.bibliography,
        bibliographyHtml: single.bibliographyHtml,
      });
    }

    return this.formatBatch(cslItems, styleId, preformattedCitations);
  }

  public format(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
  ): EngineCitationResult {
    this.initTemplates();
    const normalizedStyle = this.normalizeStyle(styleId);

    const cacheKey = this.getCacheKey(cslItem, normalizedStyle, index);
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

    let citeInstance: CiteInstance | null = null;
    try {
      citeInstance = new Cite(cslItem);
      const cite = citeInstance;
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
          bibliographyHtml: `[${index}] ${this.formatter.escapeHtml(String(authorListStr))}. ${this.formatter.escapeHtml(String(title))}.${journal ? ` <i>${this.formatter.escapeHtml(String(journal))}</i>.` : ''} ${this.formatter.escapeHtml(String(year))}${this.formatter.escapeHtml(String(volume))}${this.formatter.escapeHtml(String(issue))}${this.formatter.escapeHtml(String(page))}.`,
          source: 'csl-engine',
        });
      }

      if (normalizedStyle.includes('harvard')) {
        return this.setCache(cacheKey, {
          styleId: normalizedStyle,
          inText: `(${firstAuthorFamily}, ${year})`,
          bibliography: `${authorListStr} (${year}) '${title}', ${journal}${volume}${issue}${cslItem.page ? `, pp. ${cslItem.page}` : ''}.`,
          bibliographyHtml: `${this.formatter.escapeHtml(String(authorListStr))} (${this.formatter.escapeHtml(String(year))}) &lsquo;${this.formatter.escapeHtml(String(title))}&rsquo;, <i>${this.formatter.escapeHtml(String(journal))}</i>${this.formatter.escapeHtml(String(volume))}${this.formatter.escapeHtml(String(issue))}${cslItem.page ? `, pp. ${this.formatter.escapeHtml(String(cslItem.page))}` : ''}.`,
          source: 'csl-engine',
        });
      }

      const cite = citeInstance ?? new Cite(cslItem);
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
    preformattedCitations?: Array<{
      id: string;
      inText: string;
      bibliography: string;
      bibliographyHtml?: string;
    }>,
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
        TcvnCitationFormatterService.isVietnameseItem(item),
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

    let cachedList:
      | Array<{ id: string; inText: string; bibliography: string; bibliographyHtml?: string }>
      | undefined;
    const getFallbackCitation = (idx: number) => {
      if (preformattedCitations?.[idx]) return preformattedCitations[idx];
      const item = cslItems[idx];
      const single = this.format(item, normalizedStyle, idx + 1);
      return {
        id: item.id,
        inText: single.inText,
        bibliography: single.bibliography,
        bibliographyHtml: single.bibliographyHtml,
      };
    };
    const buildAllFallbackCitations = () =>
      (cachedList ??=
        preformattedCitations ?? cslItems.map((_, idx) => getFallbackCitation(idx)));

    const buildFallbackCombinedInText = (fallbackList: Array<{ inText: string }>) => {
      const isNumeric = NUMERIC_STYLE_TOKENS.some((s) => normalizedStyle.includes(s));
      if (isNumeric) return `[${cslItems.map((_, i) => i + 1).join(', ')}]`;
      const inTexts = fallbackList.map((c) => c.inText.replace(/^\(|\)$/g, '')).filter(Boolean);
      return `(${inTexts.join('; ')})`;
    };

    const isNumericStyle = NUMERIC_STYLE_TOKENS.some((s) => normalizedStyle.includes(s));
    const applyBatchYearDisambiguation = (
      list: Array<{ id: string; inText: string; bibliography: string; bibliographyHtml?: string }>,
    ) => {
      if (isNumericStyle || cslItems.length < 2) return list;
      const groups = new Map<string, number[]>();
      cslItems.forEach((item, idx) => {
        const firstAuthor = (item.author?.[0]?.family || item.author?.[0]?.literal || '').trim().toLowerCase();
        const yearRaw = item.issued?.['date-parts']?.[0]?.[0];
        const yearStr = yearRaw !== undefined && yearRaw !== null ? String(yearRaw).trim() : '';
        if (!firstAuthor || !/^\d{4}$/.test(yearStr)) return;
        const key = `${firstAuthor}::${yearStr}`;
        const arr = groups.get(key) ?? [];
        arr.push(idx);
        groups.set(key, arr);
      });

      const cloned = list.map((c) => ({ ...c }));
      for (const [key, indices] of groups.entries()) {
        if (indices.length < 2) continue;
        const yearStr = key.split('::')[1];
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
            entry.bibliography = entry.bibliography.replace(
              new RegExp(`(\\(\\s*${yearStr}|\\b${yearStr})\\b`),
              (m) => `${m}${suffix}`,
            );
          }
          if (entry.bibliographyHtml && !alreadyHasSuffixRe.test(entry.bibliographyHtml)) {
            entry.bibliographyHtml = entry.bibliographyHtml.replace(
              new RegExp(`(\\(\\s*${yearStr}|\\b${yearStr})\\b`),
              (m) => `${m}${suffix}`,
            );
          }
        });
      }
      return cloned;
    };

    try {
      if (preformattedCitations && preformattedCitations.length === cslItems.length) {
        const batchCitations = applyBatchYearDisambiguation(preformattedCitations);
        const bibliographyText = batchCitations.map((c) => c.bibliography).filter(Boolean).join('\n\n');
        const bibliographyHtml = batchCitations.map((c) => c.bibliographyHtml || '').filter(Boolean).join('\n');
        return {
          styleId: normalizedStyle,
          combinedInText: buildFallbackCombinedInText(batchCitations),
          citations: batchCitations,
          bibliographyText,
          bibliographyHtml,
        };
      }

      const cite = new Cite(cslItems);
      const bibliographyText = cite.format('bibliography', { template: normalizedStyle, lang: 'en-US' }).trim();
      const bibliographyHtml = cite
        .format('bibliography', { template: normalizedStyle, lang: 'en-US', format: 'html' })
        .trim();

      const batchCitations = applyBatchYearDisambiguation(
        cslItems.map((item, idx) => {
          const tryFormatEntry = (type: string, format?: string): string => {
            try {
              return cite.format(type, { template: normalizedStyle, lang: 'en-US', ...(format ? { format } : {}), entry: item.id }).trim();
            } catch {
              return '';
            }
          };
          const cit = tryFormatEntry('citation');
          const bib = tryFormatEntry('bibliography');
          const bibHtml = tryFormatEntry('bibliography', 'html');
          const fallback = !cit || !bib || !bibHtml ? getFallbackCitation(idx) : undefined;
          const itemInText = cit || fallback?.inText || '';
          const rawBib = bib || fallback?.bibliography || '';
          const itemBib = normalizedStyle === 'ieee' && bib ? rawBib.replace(/[\u201C\u201D]/g, '"') : rawBib;
          const itemBibHtml = bibHtml || fallback?.bibliographyHtml;
          return { id: item.id, inText: itemInText, bibliography: itemBib, bibliographyHtml: itemBibHtml };
        }),
      );

      let combinedInText = '';
      try {
        combinedInText = cite.format('citation', { template: normalizedStyle, lang: 'en-US' }).trim();
      } catch {
        combinedInText = buildFallbackCombinedInText(batchCitations);
      }

      return {
        styleId: normalizedStyle,
        combinedInText,
        citations: batchCitations,
        bibliographyText,
        bibliographyHtml,
      };
    } catch {
      const citations = buildAllFallbackCitations();
      const disambiguatedFallback = applyBatchYearDisambiguation(citations);
      return {
        styleId: normalizedStyle,
        combinedInText: buildFallbackCombinedInText(disambiguatedFallback),
        citations: disambiguatedFallback,
        bibliographyText: disambiguatedFallback.map((c) => c.bibliography).join('\n\n'),
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
}
