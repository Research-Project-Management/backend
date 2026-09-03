import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CslItemData } from '../types/csl-json.types';
import {
  IEEE_CSL,
  NATURE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
} from '../styles/official-styles.data';

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

  onModuleInit() {
    this.initTemplates();
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
    const s = (styleId || 'apa').toLowerCase().trim();
    if (s === 'apa-7th' || s === 'apa') return 'apa';
    if (s === 'mla-9th' || s === 'mla') return 'mla';
    if (s === 'chicago-author-date' || s === 'chicago') return 'chicago';
    if (s === 'harvard' || s === 'harvard1') return 'harvard1';
    return s;
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

    // 1. BibTeX
    if (normalizedStyle === 'bibtex') {
      const bibtex = this.formatBibtex(cslItem);
      return {
        styleId: 'bibtex',
        inText: `\\cite{${cslItem.id}}`,
        bibliography: bibtex,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibtex)}</pre>`,
        source: 'csl-engine',
      };
    }

    // 2. RIS
    if (normalizedStyle === 'ris') {
      const ris = this.formatRis(cslItem);
      return {
        styleId: 'ris',
        inText: cslItem.title,
        bibliography: ris,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(ris)}</pre>`,
        source: 'csl-engine',
      };
    }

    // 3. CSL Styles (APA, IEEE, Nature, Chicago, MLA, Harvard, Vancouver)
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

      return {
        styleId: normalizedStyle,
        inText,
        bibliography,
        bibliographyHtml,
        source: 'csl-engine',
      };
    } catch (err: any) {
      this.logger.warn(
        `Failed to render CSL template ${normalizedStyle}: ${err?.message || err}. Falling back to APA.`,
      );
      // Resilient fallback to APA
      const cite = new Cite(cslItem);
      return {
        styleId: 'apa',
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
      };
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
    citations: Array<{ id: string; inText: string; bibliography: string }>;
    bibliographyText: string;
    bibliographyHtml: string;
  } {
    this.initTemplates();
    const normalizedStyle = this.normalizeStyle(styleId);

    if (cslItems.length === 0) {
      return {
        styleId: normalizedStyle,
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
        citations: cslItems.map((item, idx) => ({
          id: item.id,
          inText: `\\cite{${item.id}}`,
          bibliography: bibs[idx],
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
        citations: cslItems.map((item, idx) => ({
          id: item.id,
          inText: item.title,
          bibliography: riss[idx],
        })),
        bibliographyText,
        bibliographyHtml: `<pre class="font-mono text-xs whitespace-pre-wrap">${this.escapeHtml(bibliographyText)}</pre>`,
      };
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
        };
      });

      return {
        styleId: normalizedStyle,
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
        };
      });
      return {
        styleId: normalizedStyle,
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
      const raw = cite.format('bibtex');
      if (raw && raw.trim().startsWith('@')) {
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
}
