import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
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

interface CitationJsTemplateStore {
  has(id: string): boolean;
  add(id: string, xml: string): void;
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

export const BUILTIN_SPECIAL_STYLES = new Set([
  'auto',
  'auto-numeric',
  'bibtex',
  'ris',
  'tcvn',
  'tcvn-numeric',
]);

export const NUMERIC_STYLE_TOKENS = [
  'vancouver',
  'nature',
  'science',
  'ieee',
  'the-lancet',
  'pnas',
  'plos',
];

@Injectable()
export class CslLocaleLoaderService {
  private readonly logger = new Logger(CslLocaleLoaderService.name);
  private templatesInitialized = false;

  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
  ) {}

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
}
