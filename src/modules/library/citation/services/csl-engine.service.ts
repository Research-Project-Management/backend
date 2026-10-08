import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { CslItemData } from '../types/csl-json.types';
import {
  IEEE_CSL,
  NATURE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
  TCVN_CSL,
  TCVN_NUMERIC_CSL,
} from '../utils/official-styles.data';
import { VI_VN_LOCALE } from '../utils/official-locales.data';
import { CslRepositoryService } from './csl-repository.service';

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

  private getCacheKey(cslItem: CslItemData, style: string): string {
    const rawId =
      (cslItem as any)._itemId ||
      cslItem.id ||
      cslItem.DOI ||
      cslItem.title ||
      '';
    const date = cslItem.issued?.['date-parts']?.[0]?.[0] || '';
    // Include BOTH version and updatedAt: `version` can be overwritten by the
    // item's own edition/software version (CslJsonMapper), which would otherwise
    // hide updatedAt and serve stale renders after the item is edited.
    const ver = cslItem.version || (cslItem as any)._version || '';
    const updated = (cslItem as any)._updatedAt || '';
    return `${rawId}::${style}::${date}::${ver}::${updated}`;
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

  /**
   * Dynamically loads and registers a CSL stylesheet template into Citation.js engine.
   */
  public async ensureTemplate(styleId: string): Promise<boolean> {
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (
      normalized === 'auto' ||
      normalized === 'auto-numeric' ||
      normalized === 'bibtex' ||
      normalized === 'ris' ||
      normalized === 'tcvn' ||
      normalized === 'tcvn-numeric'
    )
      return true;

    try {
      const csl = plugins.config.get('@csl');
      if (csl && csl.templates && csl.templates.has(normalized)) {
        return true;
      }

      if (this.cslRepo) {
        const xml = await this.cslRepo.fetchCslXml(normalized);
        if (xml && csl && csl.templates) {
          csl.templates.add(normalized, xml);
          this.logger.log(
            `Dynamically registered on-demand CSL template: "${normalized}"`,
          );
          return true;
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Could not dynamically load CSL template for "${normalized}": ${err?.message || err}`,
      );
    }

    return false;
  }

  /**
   * Registers authoritative CSL XML stylesheets into Citation.js CSL plugin.
   */
  public initTemplates() {
    if (this.templatesInitialized) return;

    try {
      // Configure BibTeX plugin to preserve custom citationKey/ID
      const bibtexConfig = plugins.config.get('@bibtex');
      if (bibtexConfig && bibtexConfig.format) {
        bibtexConfig.format.useIdAsLabel = true;
      }

      const csl = plugins.config.get('@csl');
      if (csl && csl.templates) {
        if (!csl.templates.has('ieee')) {
          csl.templates.add('ieee', IEEE_CSL);
        }
        if (!csl.templates.has('nature')) {
          csl.templates.add('nature', NATURE_CSL);
        }
        if (!csl.templates.has('chicago')) {
          csl.templates.add('chicago', CHICAGO_CSL);
          csl.templates.add('chicago-author-date', CHICAGO_CSL);
        }
        if (!csl.templates.has('mla')) {
          csl.templates.add('mla', MLA_CSL);
          csl.templates.add('mla-9th', MLA_CSL);
        }
        if (!csl.templates.has('tcvn')) {
          csl.templates.add('tcvn', TCVN_CSL);
          csl.templates.add('tcvn-author-date', TCVN_CSL);
        }
        if (!csl.templates.has('tcvn-numeric')) {
          csl.templates.add('tcvn-numeric', TCVN_NUMERIC_CSL);
        }
      }
      if (csl && csl.locales) {
        if (!csl.locales.has('vi-VN')) {
          csl.locales.add('vi-VN', VI_VN_LOCALE);
        }
        if (!csl.locales.has('vi')) {
          csl.locales.add('vi', VI_VN_LOCALE);
        }
      }
      this.templatesInitialized = true;
    } catch (err: any) {
      this.logger.error(
        `Failed to register CSL templates: ${err?.message || err}`,
      );
    }
  }

  /**
   * Normalizes style aliases to valid CSL template names.
   */
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
    )
      return 'tcvn';
    if (s === 'tcvn-numeric') return 'tcvn-numeric';
    return s;
  }

  /**
   * Asynchronously ensures the CSL stylesheet is loaded before formatting.
   */
  public async formatAsync(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
  ): Promise<EngineCitationResult> {
    await this.ensureTemplate(styleId);
    return this.format(cslItem, styleId, index);
  }

  /**
   * Asynchronously ensures the CSL stylesheet is loaded before batch formatting.
   */
  public async formatBatchAsync(
    cslItems: CslItemData[],
    styleId: string = 'apa',
  ) {
    await this.ensureTemplate(styleId);
    return this.formatBatch(cslItems, styleId);
  }

  /**
   * Formats a single CSL-JSON item in the requested international style.
   */
  public format(
    cslItem: CslItemData,
    styleId: string = 'apa',
    index: number = 1,
  ): EngineCitationResult {
    this.initTemplates();
    const normalizedStyle = this.normalizeStyle(styleId);

    // O(1) LRU In-Memory Cache Lookup
    const cacheKey = this.getCacheKey(cslItem, normalizedStyle);
    const cached = this.citationCache.get(cacheKey);
    if (cached) {
      this.citationCache.delete(cacheKey);
      this.citationCache.set(cacheKey, cached);
      return cached;
    }

    // 0. Auto style detection (Cultural & Document aware)
    if (normalizedStyle === 'auto') {
      const isVn = CslEngineService.isVietnameseItem(cslItem);
      const targetStyle = isVn ? 'tcvn' : 'apa';
      const result = this.format(cslItem, targetStyle, index);
      return this.setCache(cacheKey, {
        ...result,
        styleId: 'auto',
      });
    }

    if (normalizedStyle === 'auto-numeric') {
      const isVn = CslEngineService.isVietnameseItem(cslItem);
      const targetStyle = isVn ? 'tcvn-numeric' : 'ieee';
      const result = this.format(cslItem, targetStyle, index);
      return this.setCache(cacheKey, {
        ...result,
        styleId: 'auto-numeric',
      });
    }

    // 1. BibTeX
    if (normalizedStyle === 'bibtex') {
      const bibtex = this.formatBibtex(cslItem);
      return this.setCache(cacheKey, {
        styleId: 'bibtex',
        inText: `\\cite{${cslItem.id}}`,
        bibliography: bibtex,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibtex)}</pre>`,
        source: 'csl-engine',
      });
    }

    // 2. RIS
    if (normalizedStyle === 'ris') {
      const ris = this.formatRis(cslItem);
      return this.setCache(cacheKey, {
        styleId: 'ris',
        inText: cslItem.title,
        bibliography: ris,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(ris)}</pre>`,
        source: 'csl-engine',
      });
    }

    // 3. TCVN (Tiêu chuẩn Việt Nam - Bộ Giáo dục & Đào tạo)
    if (normalizedStyle === 'tcvn' || normalizedStyle === 'tcvn-numeric') {
      const isNumeric = normalizedStyle === 'tcvn-numeric';
      const result = this.formatTcvn(cslItem, isNumeric, index);
      return this.setCache(cacheKey, result);
    }

    // 4. CSL Styles (APA, IEEE, Nature, Chicago, MLA, Harvard, Vancouver)
    try {
      const cite = new Cite(cslItem);

      let bibliography = cite
        .format('bibliography', {
          template: normalizedStyle,
          lang: 'en-US',
        })
        .trim();

      // Normalize unicode quotation marks in plain text for broader system/regex compatibility
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
    } catch (err: any) {
      this.logger.warn(
        `Failed to render CSL template ${normalizedStyle}: ${err?.message || err}. Falling back to smart formatter.`,
      );

      const authors = cslItem.author || [];
      const firstAuthorFamily =
        authors[0]?.family || authors[0]?.literal || 'Anonymous';
      const authorListStr =
        authors.length > 0
          ? authors
              .map((a: any) =>
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

      const isNumeric = [
        'vancouver',
        'nature',
        'science',
        'ieee',
        'the-lancet',
        'pnas',
        'plos',
      ].some((s) => normalizedStyle.includes(s));

      if (isNumeric) {
        const inText = `[${index}]`;
        const bibliography = `[${index}] ${authorListStr}. ${title}.${journal ? ` ${journal}.` : ''} ${year}${volume}${issue}${page}.`;
        const bibliographyHtml = `[${index}] ${authorListStr}. ${title}.${journal ? ` <i>${journal}</i>.` : ''} ${year}${volume}${issue}${page}.`;
        return this.setCache(cacheKey, {
          styleId: normalizedStyle,
          inText,
          bibliography,
          bibliographyHtml,
          source: 'csl-engine',
        });
      }

      if (normalizedStyle.includes('harvard')) {
        const inText = `(${firstAuthorFamily}, ${year})`;
        const bibliography = `${authorListStr} (${year}) '${title}', ${journal}${volume}${issue}${cslItem.page ? `, pp. ${cslItem.page}` : ''}.`;
        const bibliographyHtml = `${authorListStr} (${year}) &lsquo;${title}&rsquo;, <i>${journal}</i>${volume}${issue}${cslItem.page ? `, pp. ${cslItem.page}` : ''}.`;
        return this.setCache(cacheKey, {
          styleId: normalizedStyle,
          inText,
          bibliography,
          bibliographyHtml,
          source: 'csl-engine',
        });
      }

      // Resilient fallback to APA with requested styleId preserved
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

  /**
   * Formats a batch of CSL-JSON items.
   */
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

    if (normalizedStyle === 'bibtex') {
      const bibs = cslItems.map((item) => this.formatBibtex(item));
      const bibliographyText = bibs.join('\n\n');
      return {
        styleId: 'bibtex',
        combinedInText: `\\cite{${cslItems.map((item) => item.id).join(', ')}}`,
        citations: cslItems.map((item, idx) => ({
          id: item.id,
          inText: `\\cite{${item.id}}`,
          bibliography: bibs[idx],
          bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibs[idx])}</pre>`,
        })),
        bibliographyText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibliographyText)}</pre>`,
      };
    }

    if (normalizedStyle === 'ris') {
      const riss = cslItems.map((item) => this.formatRis(item));
      const bibliographyText = riss.join('\n\n');
      return {
        styleId: 'ris',
        combinedInText: cslItems.map((item) => item.title).join('; '),
        citations: cslItems.map((item, idx) => ({
          id: item.id,
          inText: item.title,
          bibliography: riss[idx],
          bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(riss[idx])}</pre>`,
        })),
        bibliographyText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibliographyText)}</pre>`,
      };
    }

    if (normalizedStyle === 'auto') {
      const hasVn = cslItems.some((item) =>
        CslEngineService.isVietnameseItem(item),
      );
      const targetStyle = hasVn ? 'tcvn' : 'apa';
      const res = this.formatBatch(cslItems, targetStyle);
      return {
        ...res,
        styleId: 'auto',
      };
    }

    if (normalizedStyle === 'auto-numeric') {
      const hasVn = cslItems.some((item) =>
        CslEngineService.isVietnameseItem(item),
      );
      const targetStyle = hasVn ? 'tcvn-numeric' : 'ieee';
      const res = this.formatBatch(cslItems, targetStyle);
      return {
        ...res,
        styleId: 'auto-numeric',
      };
    }

    if (normalizedStyle === 'tcvn' || normalizedStyle === 'tcvn-numeric') {
      const isNumeric = normalizedStyle === 'tcvn-numeric';
      return this.formatTcvnBatch(cslItems, isNumeric);
    }

    try {
      const cite = new Cite(cslItems);

      const bibliographyText = cite
        .format('bibliography', {
          template: normalizedStyle,
          lang: 'en-US',
        })
        .trim();

      const bibliographyHtml = cite
        .format('bibliography', {
          template: normalizedStyle,
          lang: 'en-US',
          format: 'html',
        })
        .trim();

      const citations = cslItems.map((item, idx) => {
        const single = this.format(item, normalizedStyle, idx + 1);
        return {
          id: item.id,
          inText: single.inText,
          bibliography: single.bibliography,
          bibliographyHtml: single.bibliographyHtml,
        };
      });

      let combinedInText = '';
      try {
        combinedInText = cite
          .format('citation', {
            template: normalizedStyle,
            lang: 'en-US',
          })
          .trim();
      } catch {
        const isNumeric = [
          'vancouver',
          'nature',
          'science',
          'ieee',
          'the-lancet',
          'pnas',
          'plos',
        ].some((s) => normalizedStyle.includes(s));
        if (isNumeric) {
          combinedInText = `[${cslItems.map((_, i) => i + 1).join(', ')}]`;
        } else {
          const inTexts = citations
            .map((c) => c.inText.replace(/^\(|\)$/g, ''))
            .filter(Boolean);
          combinedInText = `(${inTexts.join('; ')})`;
        }
      }

      return {
        styleId: normalizedStyle,
        combinedInText,
        citations,
        bibliographyText,
        bibliographyHtml,
      };
    } catch {
      const citations = cslItems.map((item, idx) => {
        const single = this.format(item, normalizedStyle, idx + 1);
        return {
          id: item.id,
          inText: single.inText,
          bibliography: single.bibliography,
          bibliographyHtml: single.bibliographyHtml,
        };
      });

      const isNumeric = [
        'vancouver',
        'nature',
        'science',
        'ieee',
        'the-lancet',
        'pnas',
        'plos',
      ].some((s) => normalizedStyle.includes(s));
      const inTexts = citations
        .map((c) => c.inText.replace(/^\(|\)$/g, ''))
        .filter(Boolean);
      const combinedInText = isNumeric
        ? `[${cslItems.map((_, i) => i + 1).join(', ')}]`
        : `(${inTexts.join('; ')})`;

      return {
        styleId: normalizedStyle,
        combinedInText,
        citations,
        bibliographyText: citations.map((c) => c.bibliography).join('\n\n'),
        bibliographyHtml: '',
      };
    }
  }

  /**
   * Formats CSL-JSON into strict BibLaTeX/BibTeX with LaTeX character escaping.
   */
  public formatBibtex(cslItem: CslItemData): string {
    try {
      const cite = new Cite(cslItem);
      let raw = cite.format('bibtex');
      if (raw && raw.trim().startsWith('@')) {
        const typeMap: Record<string, string> = {
          'article-journal': 'article',
          'paper-conference': 'inproceedings',
          book: 'book',
          chapter: 'incollection',
          report: 'techreport',
          thesis: 'phdthesis',
        };
        const targetType = typeMap[cslItem.type];
        if (targetType && /^@misc\{/i.test(raw.trim())) {
          raw = raw.replace(/^@misc\{/i, `@${targetType}{`);
        }
        return raw.trim();
      }
    } catch {
      // Fallback manual serializer with strict escaping
    }

    return this.fallbackBibtex(cslItem);
  }

  /**
   * Formats CSL-JSON into standard RIS format.
   */
  public formatRis(cslItem: CslItemData): string {
    try {
      const cite = new Cite(cslItem);
      const raw = cite.format('ris');
      if (raw && raw.trim().startsWith('TY  -')) {
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
    const authors = (item.author || [])
      .map((a) => `${a.family || ''}, ${a.given || ''}`.trim())
      .join(' and ');

    const typeMap: Record<string, string> = {
      'article-journal': 'article',
      'paper-conference': 'inproceedings',
      book: 'book',
      chapter: 'incollection',
      report: 'techreport',
      thesis: 'phdthesis',
    };
    const entryType = typeMap[item.type] || 'misc';

    // Strict LaTeX escaping for title
    const escapedTitle = (item.title || '')
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/#/g, '\\#');

    const lines = [`@${entryType}{${key},`];
    lines.push(`  title = {${escapedTitle}},`);
    if (authors) lines.push(`  author = {${authors}},`);
    if (item['container-title']) {
      const journalField = entryType === 'article' ? 'journal' : 'booktitle';
      lines.push(`  ${journalField} = {${item['container-title']}},`);
    }
    const year = item.issued?.['date-parts']?.[0]?.[0];
    if (year) lines.push(`  year = {${year}},`);
    if (item.volume) lines.push(`  volume = {${item.volume}},`);
    if (item.issue) lines.push(`  number = {${item.issue}},`);
    if (item.page) lines.push(`  pages = {${item.page}},`);
    if (item.DOI) lines.push(`  doi = {${item.DOI}},`);
    if (item.URL) lines.push(`  url = {${item.URL}},`);
    lines.push('}');

    return lines.join('\n');
  }

  private fallbackRis(item: CslItemData): string {
    const typeMap: Record<string, string> = {
      'article-journal': 'JOUR',
      'paper-conference': 'CONF',
      book: 'BOOK',
      chapter: 'CHAP',
      report: 'RPRT',
      thesis: 'THES',
    };
    const risType = typeMap[item.type] || 'GEN';

    const lines = [`TY  - ${risType}`];
    lines.push(`TI  - ${item.title}`);
    (item.author || []).forEach((a) => {
      lines.push(`AU  - ${a.family || ''}, ${a.given || ''}`.trim());
    });
    if (item['container-title']) lines.push(`T2  - ${item['container-title']}`);
    const year = item.issued?.['date-parts']?.[0]?.[0];
    if (year) lines.push(`PY  - ${year}`);
    if (item.volume) lines.push(`VL  - ${item.volume}`);
    if (item.issue) lines.push(`IS  - ${item.issue}`);
    if (item.page) lines.push(`SP  - ${item.page}`);
    if (item.DOI) lines.push(`DO  - ${item.DOI}`);
    if (item.URL) lines.push(`UR  - ${item.URL}`);
    lines.push('ER  - ');

    return lines.join('\n');
  }

  // ── TCVN / BỘ GIÁO DỤC & ĐÀO TẠO CITATION ENGINE ──────────────────────────

  private static readonly VN_SURNAMES_REGEX =
    /^(nguy[eễ]n|tr[aầ]n|l[eê]|ph[aạ]m|ho[aà]ng|hu[yỳ]nh|phan|v[uũ]|v[oõ]|đ[aặ]ng|b[uù]i|đ[oỗ]|h[oồ]|ng[oô]|d[uư][oơ]ng|l[yý]|đinh|đo[aà]n|l[aâ]m|tr[iị]nh|mai|đ[aà]o|cao|h[aà]|l[uư]u|l[uư][oơ]ng|th[aá]i|t[aạ]|ph[uù]ng|t[oô]|v[uư][oơ]ng|chu|ch[aâ]u|t[oố]ng|qu[aá]ch|tri[eệ]u|nghi[eê]m|h[uứ]a|kh[oổ]ng|di[eệ]p|nhan|t[aă]ng|th[aạ]ch|ti[eê]u|l[uụ]c|m[aã]|ch[uử]|ki[eề]u|do[aã]n|c[uù]|b[aạ]ch|[aâ]n|b[aà]ng|tr[uư][oơ]ng|t[oô]n|qu[aả]n|đ[aậ]u|n[oô]ng|l[aạ]i|ph[ií]|la)(\s|$)/i;

  public static isVietnameseAuthor(author: any): boolean {
    if (!author) return false;
    if (author.literal) {
      return /[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i.test(
        author.literal,
      );
    }
    const full = `${author.family || ''} ${author.given || ''}`.trim();
    if (
      /[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i.test(
        full,
      )
    ) {
      return true;
    }
    return CslEngineService.VN_SURNAMES_REGEX.test(author.family || '');
  }

  public static getVietnameseSortKey(author: any): {
    primary: string;
    secondary: string;
  } {
    if (!author) return { primary: '', secondary: '' };
    if (author.literal) {
      return { primary: author.literal.trim(), secondary: '' };
    }
    if (author.given) {
      const givenParts = author.given.trim().split(/\s+/);
      const primary = givenParts[givenParts.length - 1]; // Given name (Tên chính)
      const middle = givenParts.slice(0, -1).join(' ');
      const secondary = `${author.family || ''} ${middle}`.trim();
      return { primary, secondary };
    }
    return { primary: author.family || '', secondary: '' };
  }

  public static isVietnameseItem(item: CslItemData): boolean {
    const firstAuthor = item.author?.[0];
    if (firstAuthor && CslEngineService.isVietnameseAuthor(firstAuthor)) {
      return true;
    }
    if (
      item.title &&
      /[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i.test(
        item.title,
      )
    ) {
      return true;
    }
    return false;
  }

  public static compareTcvnEntries(a: CslItemData, b: CslItemData): number {
    const isVnA = CslEngineService.isVietnameseItem(a);
    const isVnB = CslEngineService.isVietnameseItem(b);

    if (isVnA && !isVnB) return -1;
    if (!isVnA && isVnB) return 1;

    if (isVnA && isVnB) {
      const authorA = a.author?.[0];
      const authorB = b.author?.[0];
      const keyA = CslEngineService.getVietnameseSortKey(authorA);
      const keyB = CslEngineService.getVietnameseSortKey(authorB);
      const cmp = keyA.primary.localeCompare(keyB.primary, 'vi', {
        sensitivity: 'base',
      });
      if (cmp !== 0) return cmp;
      return keyA.secondary.localeCompare(keyB.secondary, 'vi', {
        sensitivity: 'base',
      });
    }

    const famA =
      a.author?.[0]?.family || a.author?.[0]?.literal || a.title || '';
    const famB =
      b.author?.[0]?.family || b.author?.[0]?.literal || b.title || '';
    return famA.localeCompare(famB, 'en', { sensitivity: 'base' });
  }

  public static formatTcvnAuthorName(author: any): string {
    if (!author) return 'Khuyết danh';
    if (author.literal) return author.literal.trim();

    if (CslEngineService.isVietnameseAuthor(author)) {
      return (
        `${author.family || ''} ${author.given || ''}`.trim() || 'Khuyết danh'
      );
    }

    const family = author.family || '';
    if (author.given) {
      const initials = author.given
        .trim()
        .split(/\s+/)
        .map((p: string) => p[0] + '.')
        .join(' ');
      return `${family}, ${initials}`.trim();
    }
    return family || 'Anonymous';
  }

  public static formatTcvnInTextAuthor(author: any): string {
    if (!author) return 'Khuyết danh';
    if (author.literal) return author.literal.trim();

    if (CslEngineService.isVietnameseAuthor(author)) {
      return (
        `${author.family || ''} ${author.given || ''}`.trim() || 'Khuyết danh'
      );
    }

    return author.family || 'Anonymous';
  }

  public formatTcvn(
    cslItem: CslItemData,
    isNumeric: boolean = false,
    index: number = 1,
  ): EngineCitationResult {
    const authors = cslItem.author || [];
    const formattedAuthors = authors.map((a: any) =>
      CslEngineService.formatTcvnAuthorName(a),
    );

    let authorStr = '';
    if (formattedAuthors.length === 0) {
      authorStr = 'Khuyết danh';
    } else if (formattedAuthors.length === 1) {
      authorStr = formattedAuthors[0];
    } else if (formattedAuthors.length === 2) {
      authorStr = `${formattedAuthors[0]} và ${formattedAuthors[1]}`;
    } else if (formattedAuthors.length === 3) {
      authorStr = `${formattedAuthors[0]}, ${formattedAuthors[1]} và ${formattedAuthors[2]}`;
    } else {
      authorStr = `${formattedAuthors.slice(0, 3).join(', ')} và c.s.`;
    }

    const year = cslItem.issued?.['date-parts']?.[0]?.[0] || 'không ngày';
    const title = cslItem.title || 'Không có tiêu đề';
    const journal = cslItem['container-title'] || '';
    const volume = cslItem.volume ? `tập ${cslItem.volume}` : '';
    const issue = cslItem.issue ? `(${cslItem.issue})` : '';
    const page = cslItem.page ? `tr. ${cslItem.page}` : '';
    const publisher = cslItem.publisher || '';
    const place = cslItem['publisher-place'] || '';
    const url = cslItem.URL || '';

    let inText = '';
    if (isNumeric) {
      inText = `[${index}]`;
    } else {
      const inTextAuthors = authors.map((a: any) =>
        CslEngineService.formatTcvnInTextAuthor(a),
      );
      if (inTextAuthors.length === 0) {
        inText = `(Khuyết danh, ${year})`;
      } else if (inTextAuthors.length === 1) {
        inText = `(${inTextAuthors[0]}, ${year})`;
      } else if (inTextAuthors.length === 2) {
        inText = `(${inTextAuthors[0]} và ${inTextAuthors[1]}, ${year})`;
      } else {
        inText = `(${inTextAuthors[0]} và c.s., ${year})`;
      }
    }

    let details = '';
    let detailsHtml = '';
    const type = cslItem.type || 'article-journal';

    if (
      type === 'article-journal' ||
      type === 'article-magazine' ||
      type === 'article'
    ) {
      const volIssueParts = [volume ? `${volume}${issue}` : issue, page]
        .filter(Boolean)
        .join(', ');
      const journalPart = [journal, volIssueParts].filter(Boolean).join(', ');
      details = `"${title}"${journalPart ? `, ${journalPart}` : ''}.`;
      detailsHtml = `"${this.escapeHtml(title)}"${journal ? `, <i>${this.escapeHtml(journal)}</i>` : ''}${volIssueParts ? `, ${this.escapeHtml(volIssueParts)}` : ''}.`;
    } else if (type === 'book' || type === 'bookSection') {
      const pubParts = [publisher, place].filter(Boolean).join(', ');
      details = `${title}${pubParts ? `, ${pubParts}` : ''}.`;
      detailsHtml = `<i>${this.escapeHtml(title)}</i>${pubParts ? `, ${this.escapeHtml(pubParts)}` : ''}.`;
    } else if (type === 'paper-conference') {
      details = `"${title}", Kỷ yếu ${journal || 'Hội nghị Khoa học'}${page ? `, ${page}` : ''}.`;
      detailsHtml = `"${this.escapeHtml(title)}", <i>Kỷ yếu ${this.escapeHtml(journal || 'Hội nghị Khoa học')}</i>${page ? `, ${this.escapeHtml(page)}` : ''}.`;
    } else if (type === 'thesis') {
      const genre = cslItem.genre || 'Luận án tiến sĩ';
      details = `${title}, ${genre}${publisher ? `, ${publisher}` : ''}.`;
      detailsHtml = `<i>${this.escapeHtml(title)}</i>, ${this.escapeHtml(genre)}${publisher ? `, ${this.escapeHtml(publisher)}` : ''}.`;
    } else {
      details = `"${title}"${journal ? `, ${journal}` : ''}${url ? `, <${url}>` : ''}.`;
      detailsHtml = `"${this.escapeHtml(title)}"${journal ? `, <i>${this.escapeHtml(journal)}</i>` : ''}${url ? `, &lt;${this.escapeHtml(url)}&gt;` : ''}.`;
    }

    const prefix = isNumeric ? `[${index}] ` : '';
    const bibliography = `${prefix}${authorStr} (${year}), ${details}`.trim();
    const bibliographyHtml =
      `${prefix}${this.escapeHtml(authorStr)} (${year}), ${detailsHtml}`.trim();

    return {
      styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
      inText,
      bibliography,
      bibliographyHtml,
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

    const bibliographyText = citations.map((c) => c.bibliography).join('\n\n');
    const bibliographyHtml = citations
      .map((c) => `<div class="csl-entry">${c.bibliographyHtml}</div>`)
      .join('\n');

    let combinedInText = '';
    if (isNumeric) {
      combinedInText = `[${citations.map((_, i) => i + 1).join(', ')}]`;
    } else {
      const inTexts = citations
        .map((c) => c.inText.replace(/^\(|\)$/g, ''))
        .filter(Boolean);
      combinedInText = `(${inTexts.join('; ')})`;
    }

    return {
      styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
      combinedInText,
      citations,
      bibliographyText,
      bibliographyHtml,
    };
  }
}
