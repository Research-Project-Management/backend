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
import {
  IEEE_CSL,
  NATURE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
  TCVN_CSL,
  TCVN_NUMERIC_CSL,
} from '@/modules/library/citation/data/official-styles.data';
import { VI_VN_LOCALE } from '@/modules/library/citation/data/official-locales.data';
import { CslRepositoryService } from './csl-repository.service';
import {
  VIETNAMESE_SURNAMES_PREFIX_REGEX,
  hasVietnameseDiacritics,
} from '@/modules/library/shared-kernel';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite, plugins } = require('@citation-js/core');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-csl');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-bibtex');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-ris');

export interface EngineCitationResult {
  styleId: string;
  inText: string;
  bibliography: string;
  bibliographyHtml?: string;
  source: 'csl-engine';
}

const BUILTIN_SPECIAL_STYLES = new Set([
  'auto',
  'auto-numeric',
  'bibtex',
  'ris',
  'tcvn',
  'tcvn-numeric',
]);

const NUMERIC_STYLE_TOKENS = [
  'vancouver',
  'nature',
  'science',
  'ieee',
  'the-lancet',
  'pnas',
  'plos',
];

const BIBTEX_ITEM_TYPE_MAP: Record<string, string> = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'incollection',
  dictionaryEntry: 'incollection',
  encyclopediaArticle: 'incollection',
  conferencePaper: 'inproceedings',
  report: 'techreport',
  patent: 'patent',
  dataset: 'dataset',
  computerProgram: 'software',
  standard: 'standard',
  webpage: 'online',
  blogPost: 'online',
  forumPost: 'online',
  preprint: 'unpublished',
  manuscript: 'unpublished',
  case: 'jurisdiction',
  statute: 'legislation',
  bill: 'legislation',
};

const BIBTEX_CSL_TYPE_MAP: Record<string, string> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  'paper-conference': 'inproceedings',
  book: 'book',
  chapter: 'incollection',
  'entry-dictionary': 'incollection',
  'entry-encyclopedia': 'incollection',
  report: 'techreport',
  thesis: 'phdthesis',
  patent: 'patent',
  dataset: 'dataset',
  software: 'software',
  standard: 'standard',
  webpage: 'online',
  'post-weblog': 'online',
  post: 'online',
  manuscript: 'unpublished',
  article: 'unpublished',
  legal_case: 'jurisdiction',
  legislation: 'legislation',
  bill: 'legislation',
};

const RIS_ITEM_TYPE_MAP: Record<string, string> = {
  journalArticle: 'JOUR',
  magazineArticle: 'MGZN',
  newspaperArticle: 'NEWS',
  book: 'BOOK',
  bookSection: 'CHAP',
  dictionaryEntry: 'DICT',
  encyclopediaArticle: 'ENCYC',
  conferencePaper: 'CONF',
  thesis: 'THES',
  report: 'RPRT',
  patent: 'PAT',
  dataset: 'DATA',
  computerProgram: 'COMP',
  standard: 'STAND',
  webpage: 'ELEC',
  blogPost: 'BLOG',
  forumPost: 'ELEC',
  preprint: 'UNPB',
  manuscript: 'UNPB',
  case: 'CASE',
  statute: 'STAT',
  bill: 'BILL',
  hearing: 'HEAR',
  letter: 'PCOMM',
  interview: 'INTV',
  film: 'MPCT',
  videoRecording: 'VIDEO',
  audioRecording: 'SOUND',
  artwork: 'ART',
  map: 'MAP',
  presentation: 'SLIDE',
};

const RIS_CSL_TYPE_MAP: Record<string, string> = {
  'article-journal': 'JOUR',
  'article-magazine': 'MGZN',
  'article-newspaper': 'NEWS',
  'paper-conference': 'CONF',
  book: 'BOOK',
  chapter: 'CHAP',
  report: 'RPRT',
  thesis: 'THES',
  patent: 'PAT',
  dataset: 'DATA',
  software: 'COMP',
  standard: 'STAND',
  webpage: 'ELEC',
  'post-weblog': 'BLOG',
  post: 'ELEC',
  manuscript: 'UNPB',
  legal_case: 'CASE',
  legislation: 'STAT',
  bill: 'BILL',
};

@Injectable()
export class CslEngineService implements OnModuleInit {
  private readonly logger = new Logger(CslEngineService.name);
  private templatesInitialized = false;
  private readonly citationCache = new Map<string, EngineCitationResult>();
  private readonly maxCacheEntries = 2000;

  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
  ) {}

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
    if (!styleId) return false;
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized)) return true;
    try {
      const csl = plugins.config.get('@csl');
      return Boolean(csl?.templates?.has(normalized));
    } catch {
      return false;
    }
  }

  public async ensureTemplate(styleId: string): Promise<boolean> {
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized)) return true;

    try {
      const csl = plugins.config.get('@csl');
      if (csl?.templates?.has(normalized)) return true;

      if (this.cslRepo) {
        const xml = await this.cslRepo.fetchCslXml(normalized);
        if (xml && csl?.templates) {
          csl.templates.add(normalized, xml);
          this.logger.log(
            `Dynamically registered on-demand CSL template: "${normalized}"`,
          );
          return true;
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Could not dynamically load CSL template for "${normalized}": ${errMsg}`,
      );
    }
    return false;
  }

  public initTemplates() {
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
          ['tcvn', TCVN_CSL],
          ['tcvn-author-date', TCVN_CSL],
          ['tcvn-numeric', TCVN_NUMERIC_CSL],
        ];
        for (const [id, xml] of templateBindings) {
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

  public normalizeStyle(styleId: string): string {
    const s = (styleId || 'auto').toLowerCase().trim();
    if (s === 'auto' || s === 'default' || !s) return 'auto';
    if (s === 'auto-numeric' || s === 'numeric') return 'auto-numeric';
    if (s === 'apa-7th' || s === 'apa') return 'apa';
    if (s === 'mla-9th' || s === 'mla') return 'mla';
    if (s === 'chicago-author-date' || s === 'chicago') return 'chicago';
    if (s === 'harvard' || s === 'harvard1') return 'harvard1';
    if (
      s === 'tcvn' ||
      s === 'tcvn-author-date' ||
      s === 'bo-giao-duc' ||
      s === 'vietnam'
    ) {
      return 'tcvn';
    }
    if (s === 'tcvn-numeric') return 'tcvn-numeric';
    return s;
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
        ? this.formatBibtex(cslItem)
        : this.formatRis(cslItem);
      return this.setCache(cacheKey, {
        styleId: normalizedStyle,
        inText: isBib ? `\\cite{${cslItem.id}}` : cslItem.title,
        bibliography: rawText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(rawText)}</pre>`,
        source: 'csl-engine',
      });
    }

    if (normalizedStyle === 'tcvn' || normalizedStyle === 'tcvn-numeric') {
      return this.setCache(
        cacheKey,
        this.formatTcvn(cslItem, normalizedStyle === 'tcvn-numeric', index),
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
        isBib ? this.formatBibtex(item) : this.formatRis(item),
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
          bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(renderedList[idx])}</pre>`,
        })),
        bibliographyText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibliographyText)}</pre>`,
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
      return this.formatTcvnBatch(cslItems, normalizedStyle === 'tcvn-numeric');
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

  private resolveBibtexEntryType(cslItem: CslItemData): string {
    const rawItemType =
      typeof cslItem._itemType === 'string' ? cslItem._itemType : '';
    const genre = typeof cslItem.genre === 'string' ? cslItem.genre : '';

    if (rawItemType === 'thesis' || cslItem.type === 'thesis') {
      return /\b(?:master|m\.?s\.?|m\.?a\.?|m\.?eng|m\.?sc|thạc\s*sĩ)\b/i.test(
        genre,
      )
        ? 'mastersthesis'
        : 'phdthesis';
    }
    if (rawItemType && BIBTEX_ITEM_TYPE_MAP[rawItemType]) {
      return BIBTEX_ITEM_TYPE_MAP[rawItemType];
    }
    return BIBTEX_CSL_TYPE_MAP[cslItem.type] || 'misc';
  }

  private resolveRisType(cslItem: CslItemData): string {
    const rawItemType =
      typeof cslItem._itemType === 'string' ? cslItem._itemType : '';
    if (rawItemType && RIS_ITEM_TYPE_MAP[rawItemType]) {
      return RIS_ITEM_TYPE_MAP[rawItemType];
    }
    return RIS_CSL_TYPE_MAP[cslItem.type] || 'GEN';
  }

  private formatBibtexCreatorList(list?: CslName[]): string {
    if (!Array.isArray(list) || list.length === 0) return '';
    return list
      .map((c) => {
        if (c.literal && !c.family && !c.given) {
          return `{${c.literal.trim()}}`;
        }
        return `${c.family || c.literal || ''}, ${c.given || ''}`
          .replace(/,\s*$/, '')
          .trim();
      })
      .filter(Boolean)
      .join(' and ');
  }

  private formatIsoDateFromCsl(dateObj?: {
    'date-parts'?: Array<Array<number | string>>;
  }): string | undefined {
    const parts = dateObj?.['date-parts']?.[0];
    if (!Array.isArray(parts) || !parts[0]) return undefined;
    const y = String(parts[0]).padStart(4, '0');
    if (parts[1]) {
      const m = String(parts[1]).padStart(2, '0');
      if (parts[2]) {
        const d = String(parts[2]).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      return `${y}-${m}`;
    }
    return y;
  }

  /**
   * Declarative BibTeX field emitter used by both `formatBibtex` (to inject missing fields)
   * and `fallbackBibtex`.
   */
  private collectBibtexSupplementPairs(
    cslItem: CslItemData,
    targetType: string,
  ): Array<[string, string | number]> {
    const pairs: Array<[string, string | number]> = [];
    const pushIf = (key: string, val: unknown) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        pairs.push([key, typeof val === 'number' ? val : String(val)]);
      }
    };

    if (cslItem.page) {
      pushIf(
        'pages',
        String(cslItem.page).replace(/^(\d+)\s*[-–—]+\s*(\d+)$/, '$1--$2'),
      );
    }
    if (cslItem.publisher) {
      if (targetType === 'phdthesis' || targetType === 'mastersthesis') {
        pushIf('school', cslItem.publisher);
      } else if (targetType === 'techreport' || targetType === 'standard') {
        pushIf('institution', cslItem.publisher);
      } else {
        pushIf('publisher', cslItem.publisher);
      }
    }
    if (
      (targetType === 'incollection' || targetType === 'inproceedings') &&
      cslItem['container-title']
    ) {
      pushIf('booktitle', cslItem['container-title']);
    }
    if (Array.isArray(cslItem.editor) && cslItem.editor.length > 0) {
      pushIf('editor', this.formatBibtexCreatorList(cslItem.editor));
    }
    pushIf('series', cslItem['collection-title']);
    pushIf('edition', cslItem.edition);
    pushIf('address', cslItem['publisher-place']);
    pushIf('number', cslItem.number ?? cslItem.issue);
    pushIf('type', cslItem.genre);
    pushIf('version', cslItem.version);
    pushIf('isbn', cslItem.ISBN);
    pushIf('issn', cslItem.ISSN);
    pushIf('doi', cslItem.DOI);
    pushIf('pmid', cslItem.PMID);
    pushIf('pmcid', cslItem.PMCID);
    pushIf('url', cslItem.URL);
    pushIf('urldate', this.formatIsoDateFromCsl(cslItem.accessed));

    const arxivId =
      typeof cslItem._arxivId === 'string' && cslItem._arxivId
        ? cslItem._arxivId
        : typeof cslItem.note === 'string'
          ? cslItem.note.match(/arxiv:\s*(\S+)/i)?.[1]
          : undefined;
    if (arxivId) {
      pushIf('eprint', arxivId);
      pushIf('archiveprefix', 'arXiv');
    }

    return pairs;
  }

  public formatBibtex(cslItem: CslItemData): string {
    const targetType = this.resolveBibtexEntryType(cslItem);
    try {
      const cite = new Cite(cslItem);
      let raw = cite.format('bibtex');
      if (raw && raw.trim().startsWith('@')) {
        raw = raw.replace(/^@[a-zA-Z]+\{/i, `@${targetType}{`);
        if (cslItem.id) {
          raw = raw.replace(/^(@[a-zA-Z]+\{)[^,]+,/, `$1${cslItem.id},`);
        }

        if (
          Array.isArray(cslItem.author) &&
          cslItem.author.some((a) =>
            Boolean(a.literal && !a.family && !a.given),
          )
        ) {
          const formattedAuthors = this.formatBibtexCreatorList(cslItem.author);
          if (formattedAuthors) {
            raw = /\bauthor\s*=\s*\{[^}]*\}/i.test(raw)
              ? raw.replace(
                  /\bauthor\s*=\s*\{[^}]*\}/i,
                  `author = {${formattedAuthors}}`,
                )
              : raw.replace(
                  /^(@[a-zA-Z]+\{[^,]+,)/,
                  `$1\n  author = {${formattedAuthors}},`,
                );
          }
        }

        raw = raw.replace(
          /(\bpages\s*=\s*\{)(\d+)\s*[-–—]+\s*(\d+)(\})/i,
          '$1$2--$3$4',
        );

        const extraBibFields: string[] = [];
        for (const [fieldKey, val] of this.collectBibtexSupplementPairs(
          cslItem,
          targetType,
        )) {
          if (!new RegExp(`\\b${fieldKey}\\s*=`, 'i').test(raw)) {
            extraBibFields.push(`  ${fieldKey} = {${val}},`);
          }
        }

        if (extraBibFields.length > 0) {
          raw = raw.trim().replace(/\}\s*$/, `${extraBibFields.join('\n')}\n}`);
        }
        return raw.trim();
      }
    } catch {
      // Fallback manual serializer
    }

    return this.fallbackBibtex(cslItem);
  }

  /**
   * Declarative RIS tag emitter used by both `formatRis` and `fallbackRis`.
   */
  private collectRisSupplementTags(
    cslItem: CslItemData,
  ): Array<{ tag: string; checkRegex: RegExp; value: string }> {
    const entries: Array<{ tag: string; checkRegex: RegExp; value: string }> =
      [];
    const pushTag = (tag: string, val: unknown, customCheck?: RegExp) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        entries.push({
          tag,
          checkRegex: customCheck || new RegExp(`^${tag}\\s+-`, 'm'),
          value: String(val),
        });
      }
    };

    if (Array.isArray(cslItem.editor)) {
      for (const ed of cslItem.editor) {
        const edStr =
          ed.literal && !ed.family && !ed.given
            ? ed.literal.trim()
            : `${ed.family || ed.literal || ''}, ${ed.given || ''}`
                .replace(/,\s*$/, '')
                .trim();
        if (edStr) pushTag('ED', edStr);
      }
    }

    pushTag('T2', cslItem['container-title'], /^(?:T2|JO|JF|BT)\s+-/m);
    pushTag('T3', cslItem['collection-title']);
    pushTag('J2', cslItem['container-title-short']);
    pushTag('ST', cslItem['title-short']);
    pushTag('ET', cslItem.edition);
    pushTag('VL', cslItem.volume);
    pushTag('IS', cslItem.issue ?? cslItem.number);

    if (cslItem.page) {
      const pageMatch = String(cslItem.page)
        .trim()
        .match(/^(\S+?)\s*[-–—]\s*(\S+)$/);
      if (pageMatch) {
        pushTag('SP', pageMatch[1]);
        pushTag('EP', pageMatch[2]);
      } else {
        pushTag('SP', cslItem.page);
      }
    }

    pushTag('DO', cslItem.DOI);
    pushTag('AN', cslItem.PMID, /(?:PMID:|^AN\s+-)/im);
    pushTag('C2', cslItem.PMCID);
    pushTag('PB', cslItem.publisher);
    pushTag('CY', cslItem['publisher-place']);
    pushTag('SN', cslItem.ISBN || cslItem.ISSN);
    pushTag('M3', cslItem.genre);
    pushTag('UR', cslItem.URL);
    pushTag('Y2', this.formatIsoDateFromCsl(cslItem.accessed));

    if (Array.isArray(cslItem._keywords)) {
      for (const kw of cslItem._keywords) {
        if (typeof kw === 'string' && kw.trim()) {
          pushTag('KW', kw.trim());
        }
      }
    }
    pushTag('AB', cslItem.abstract);

    return entries;
  }

  public formatRis(cslItem: CslItemData): string {
    const targetRisType = this.resolveRisType(cslItem);
    try {
      const cite = new Cite(cslItem);
      let raw = cite.format('ris');
      if (raw && raw.trim().startsWith('TY  -')) {
        raw = raw
          .replace(/^TY\s+-\s+\S+/m, `TY  - ${targetRisType}`)
          .replace(/^KW\s+-\s+/gm, 'KW  - ')
          .replace(
            /^SP\s+-\s+(\S+?)\s*[-–—]\s*(\S+)\s*$/m,
            'SP  - $1\nEP  - $2',
          );

        const extraRisLines: string[] = [];
        for (const { tag, checkRegex, value } of this.collectRisSupplementTags(
          cslItem,
        )) {
          if (!checkRegex.test(raw)) {
            extraRisLines.push(`${tag}  - ${value}`);
          }
        }

        if (extraRisLines.length > 0) {
          raw = raw
            .trim()
            .replace(/ER\s*-\s*$/, `${extraRisLines.join('\n')}\nER  - `);
        }
        return raw.trim();
      }
    } catch {
      // Fallback
    }

    return this.fallbackRis(cslItem);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private fallbackBibtex(item: CslItemData): string {
    const key = item.id || `ref_${Date.now()}`;
    const authors = this.formatBibtexCreatorList(item.author);
    const entryType = this.resolveBibtexEntryType(item);
    const escapedTitle = (item.title || '')
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/#/g, '\\#');

    const lines = [`@${entryType}{${key},`, `  title = {${escapedTitle}},`];
    if (authors) lines.push(`  author = {${authors}},`);
    if (entryType === 'article' && item['container-title']) {
      lines.push(`  journal = {${item['container-title']}},`);
    }
    const year = item.issued?.['date-parts']?.[0]?.[0];
    if (year) lines.push(`  year = {${year}},`);
    if (item.volume) lines.push(`  volume = {${item.volume}},`);

    for (const [fieldKey, val] of this.collectBibtexSupplementPairs(
      item,
      entryType,
    )) {
      lines.push(`  ${fieldKey} = {${val}},`);
    }
    lines.push('}');
    return lines.join('\n');
  }

  private fallbackRis(item: CslItemData): string {
    const risType = this.resolveRisType(item);
    const lines = [`TY  - ${risType}`, `TI  - ${item.title}`];
    for (const a of item.author || []) {
      lines.push(
        `AU  - ${a.family || a.literal || ''}, ${a.given || ''}`
          .replace(/,\s*$/, '')
          .trim(),
      );
    }
    const year = item.issued?.['date-parts']?.[0]?.[0];
    if (year) lines.push(`PY  - ${year}`);

    for (const { tag, value } of this.collectRisSupplementTags(item)) {
      lines.push(`${tag}  - ${value}`);
    }
    lines.push('ER  - ');
    return lines.join('\n');
  }

  // ── TCVN / BỘ GIÁO DỤC & ĐÀO TẠO CITATION ENGINE ──────────────────────────

  private static readonly VN_SURNAMES_REGEX = VIETNAMESE_SURNAMES_PREFIX_REGEX;
  private static readonly ACADEMIC_DEGREES_REGEX =
    /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi;

  private static stripAcademicDegrees(text: string): string {
    return (text || '').trim().replace(this.ACADEMIC_DEGREES_REGEX, '').trim();
  }

  public static isVietnameseAuthor(author?: CslName | null): boolean {
    if (!author) return false;
    if (author.literal) return hasVietnameseDiacritics(author.literal);
    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');
    if (hasVietnameseDiacritics(`${cleanFamily} ${cleanGiven}`.trim())) {
      return true;
    }
    return CslEngineService.VN_SURNAMES_REGEX.test(cleanFamily);
  }

  public static getVietnameseSortKey(author?: CslName | null): {
    primary: string;
    secondary: string;
  } {
    if (!author) return { primary: '', secondary: '' };
    if (author.literal) {
      return {
        primary: this.stripAcademicDegrees(author.literal),
        secondary: '',
      };
    }
    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');
    if (cleanGiven) {
      const givenParts = cleanGiven.split(/\s+/);
      const primary = givenParts[givenParts.length - 1];
      const middle = givenParts.slice(0, -1).join(' ');
      return { primary, secondary: `${cleanFamily} ${middle}`.trim() };
    }
    const familyParts = cleanFamily.split(/\s+/).filter(Boolean);
    if (familyParts.length > 1) {
      return {
        primary: familyParts[familyParts.length - 1],
        secondary: familyParts.slice(0, -1).join(' '),
      };
    }
    return { primary: cleanFamily, secondary: '' };
  }

  public static isVietnameseItem(item: CslItemData): boolean {
    const firstAuthor = item.author?.[0];
    if (firstAuthor && CslEngineService.isVietnameseAuthor(firstAuthor)) {
      return true;
    }
    return Boolean(item.title && hasVietnameseDiacritics(item.title));
  }

  public static compareTcvnEntries(
    itemA: CslItemData,
    itemB: CslItemData,
  ): number {
    const isVnA = CslEngineService.isVietnameseItem(itemA);
    const isVnB = CslEngineService.isVietnameseItem(itemB);
    if (isVnA && !isVnB) return -1;
    if (!isVnA && isVnB) return 1;

    if (isVnA && isVnB) {
      const keyA = CslEngineService.getVietnameseSortKey(itemA.author?.[0]);
      const keyB = CslEngineService.getVietnameseSortKey(itemB.author?.[0]);
      const cmp = keyA.primary.localeCompare(keyB.primary, 'vi', {
        sensitivity: 'base',
      });
      return cmp !== 0
        ? cmp
        : keyA.secondary.localeCompare(keyB.secondary, 'vi', {
            sensitivity: 'base',
          });
    }

    const famA =
      itemA.author?.[0]?.family ||
      itemA.author?.[0]?.literal ||
      itemA.title ||
      '';
    const famB =
      itemB.author?.[0]?.family ||
      itemB.author?.[0]?.literal ||
      itemB.title ||
      '';
    return famA.localeCompare(famB, 'en', { sensitivity: 'base' });
  }

  public static formatTcvnAuthorName(author?: CslName | null): string {
    if (!author) return 'Khuyết danh';
    if (author.literal) return this.stripAcademicDegrees(author.literal);

    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');

    if (CslEngineService.isVietnameseAuthor(author)) {
      return `${cleanFamily} ${cleanGiven}`.trim() || 'Khuyết danh';
    }
    if (cleanGiven) {
      const initials = cleanGiven
        .split(/\s+/)
        .filter(Boolean)
        .map((p: string) => p[0] + '.')
        .join(' ');
      return `${cleanFamily}, ${initials}`.trim();
    }
    return cleanFamily || 'Anonymous';
  }

  public static formatTcvnInTextAuthor(author?: CslName | null): string {
    if (!author) return 'Khuyết danh';
    if (author.literal) return this.stripAcademicDegrees(author.literal);

    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');

    if (CslEngineService.isVietnameseAuthor(author)) {
      return `${cleanFamily} ${cleanGiven}`.trim() || 'Khuyết danh';
    }
    return cleanFamily || 'Anonymous';
  }

  public formatTcvn(
    cslItem: CslItemData,
    isNumeric: boolean = false,
    index: number = 1,
  ): EngineCitationResult {
    const authors = cslItem.author || [];
    const formattedAuthors = authors.map((a: CslName) =>
      CslEngineService.formatTcvnAuthorName(a),
    );

    const authorStr =
      formattedAuthors.length === 0
        ? 'Khuyết danh'
        : formattedAuthors.length === 1
          ? formattedAuthors[0]
          : formattedAuthors.length === 2
            ? `${formattedAuthors[0]} và ${formattedAuthors[1]}`
            : formattedAuthors.length === 3
              ? `${formattedAuthors[0]}, ${formattedAuthors[1]} và ${formattedAuthors[2]}`
              : `${formattedAuthors.slice(0, 3).join(', ')} và c.s.`;

    const year = cslItem.issued?.['date-parts']?.[0]?.[0] || 'không ngày';
    const title = cslItem.title || 'Không có tiêu đề';
    const journal = cslItem['container-title'] || '';
    const volume = cslItem.volume ? `tập ${cslItem.volume}` : '';
    const issue = cslItem.issue ? `(${cslItem.issue})` : '';
    const page = cslItem.page ? `tr. ${cslItem.page}` : '';
    const publisher = cslItem.publisher || '';
    const place = cslItem['publisher-place'] || '';
    const url = cslItem.URL || '';
    const doi = cslItem.DOI ? `DOI: ${cslItem.DOI}` : '';

    let accessedDateStr = '';
    const accessedParts = cslItem.accessed?.['date-parts']?.[0];
    if (accessedParts && accessedParts.length >= 1) {
      const accYear = accessedParts[0];
      const accMonth = accessedParts[1]
        ? String(accessedParts[1]).padStart(2, '0')
        : '01';
      const accDay = accessedParts[2]
        ? String(accessedParts[2]).padStart(2, '0')
        : '01';
      accessedDateStr =
        accessedParts.length >= 3
          ? `${accDay}/${accMonth}/${accYear}`
          : accessedParts.length === 2
            ? `${accMonth}/${accYear}`
            : `${accYear}`;
    }

    let inText = '';
    if (isNumeric) {
      inText = `[${index}]`;
    } else {
      const inTextAuthors = authors.map((a: CslName) =>
        CslEngineService.formatTcvnInTextAuthor(a),
      );
      inText =
        inTextAuthors.length === 0
          ? `(Khuyết danh, ${year})`
          : inTextAuthors.length === 1
            ? `(${inTextAuthors[0]}, ${year})`
            : inTextAuthors.length === 2
              ? `(${inTextAuthors[0]} và ${inTextAuthors[1]}, ${year})`
              : `(${inTextAuthors[0]} và c.s., ${year})`;
    }

    let details = '';
    let detailsHtml = '';
    const type = cslItem.type || 'article-journal';

    if (
      type === 'article-journal' ||
      type === 'article-magazine' ||
      type === 'article'
    ) {
      const volIssueParts = [volume ? `${volume}${issue}` : issue, page, doi]
        .filter(Boolean)
        .join(', ');
      const journalPart = [journal, volIssueParts].filter(Boolean).join(', ');
      details = `"${title}"${journalPart ? `, ${journalPart}` : ''}.`;
      detailsHtml = `"${this.escapeHtml(title)}"${journal ? `, <i>${this.escapeHtml(journal)}</i>` : ''}${volIssueParts ? `, ${this.escapeHtml(volIssueParts)}` : ''}.`;
    } else if (type === 'chapter' || type === 'bookSection') {
      const tailParts = [publisher, place, page, doi]
        .filter(Boolean)
        .join(', ');
      const inContainer = journal
        ? `Trong: ${journal}`
        : 'Trong: Sách chuyên khảo';
      const inContainerHtml = journal
        ? `Trong: <i>${this.escapeHtml(journal)}</i>`
        : 'Trong: <i>Sách chuyên khảo</i>';
      details = `"${title}", ${inContainer}${tailParts ? `, ${tailParts}` : ''}.`;
      detailsHtml = `"${this.escapeHtml(title)}", ${inContainerHtml}${tailParts ? `, ${this.escapeHtml(tailParts)}` : ''}.`;
    } else if (type === 'book') {
      const pubParts = [publisher, place, page, doi].filter(Boolean).join(', ');
      details = `${title}${pubParts ? `, ${pubParts}` : ''}.`;
      detailsHtml = `<i>${this.escapeHtml(title)}</i>${pubParts ? `, ${this.escapeHtml(pubParts)}` : ''}.`;
    } else if (type === 'paper-conference') {
      const confTail = [place, publisher, page, doi].filter(Boolean).join(', ');
      details = `"${title}", Kỷ yếu ${journal || 'Hội nghị Khoa học'}${confTail ? `, ${confTail}` : ''}.`;
      detailsHtml = `"${this.escapeHtml(title)}", <i>Kỷ yếu ${this.escapeHtml(journal || 'Hội nghị Khoa học')}</i>${confTail ? `, ${this.escapeHtml(confTail)}` : ''}.`;
    } else if (type === 'thesis') {
      const genre = cslItem.genre || 'Luận án tiến sĩ';
      const thesisTail = [publisher, place].filter(Boolean).join(', ');
      details = `${title}, ${genre}${thesisTail ? `, ${thesisTail}` : ''}.`;
      detailsHtml = `<i>${this.escapeHtml(title)}</i>, ${this.escapeHtml(genre)}${thesisTail ? `, ${this.escapeHtml(thesisTail)}` : ''}.`;
    } else {
      const accessClause = accessedDateStr
        ? `, truy cập ngày ${accessedDateStr}`
        : '';
      const urlClause = url
        ? accessedDateStr
          ? `, tại <${url}>`
          : `, <${url}>`
        : '';
      const urlClauseHtml = url
        ? accessedDateStr
          ? `, tại &lt;${this.escapeHtml(url)}&gt;`
          : `, &lt;${this.escapeHtml(url)}&gt;`
        : '';
      details = `"${title}"${journal ? `, ${journal}` : ''}${publisher ? `, ${publisher}` : ''}${accessClause}${urlClause}.`;
      detailsHtml = `"${this.escapeHtml(title)}"${journal ? `, <i>${this.escapeHtml(journal)}</i>` : ''}${publisher ? `, ${this.escapeHtml(publisher)}` : ''}${this.escapeHtml(accessClause)}${urlClauseHtml}.`;
    }

    const prefix = isNumeric ? `[${index}] ` : '';
    return {
      styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
      inText,
      bibliography: `${prefix}${authorStr} (${year}), ${details}`.trim(),
      bibliographyHtml:
        `${prefix}${this.escapeHtml(authorStr)} (${year}), ${detailsHtml}`.trim(),
      source: 'csl-engine',
    };
  }

  public formatTcvnBatch(cslItems: CslItemData[], isNumeric: boolean = false) {
    if (cslItems.length === 0) {
      return {
        styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
        combinedInText: '',
        citations: [],
        bibliographyText: '',
        bibliographyHtml: '',
      };
    }

    const sorted = [...cslItems].sort(CslEngineService.compareTcvnEntries);
    const citations = sorted.map((item, idx) => {
      const single = this.formatTcvn(item, isNumeric, idx + 1);
      return {
        id: item.id,
        inText: single.inText,
        bibliography: single.bibliography,
        bibliographyHtml: single.bibliographyHtml,
      };
    });

    const combinedInText = isNumeric
      ? `[${citations.map((_, i) => i + 1).join(', ')}]`
      : `(${citations
          .map((c) => c.inText.replace(/^\(|\)$/g, ''))
          .filter(Boolean)
          .join('; ')})`;

    return {
      styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
      combinedInText,
      citations,
      bibliographyText: citations.map((c) => c.bibliography).join('\n\n'),
      bibliographyHtml: citations
        .map((c) => `<div class="csl-entry">${c.bibliographyHtml}</div>`)
        .join('\n'),
    };
  }
}
