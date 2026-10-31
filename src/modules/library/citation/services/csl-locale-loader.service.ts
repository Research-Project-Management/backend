import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import {
  IEEE_CSL,
  NATURE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
  TCVN_CSL,
  TCVN_NUMERIC_CSL,
} from '@/modules/library/citation/data/official-styles.data';
import { VI_VN_LOCALE } from '@/modules/library/citation/data/official-styles.data';
import {
  BUILTIN_SPECIAL_STYLES,
  NUMERIC_STYLE_TOKENS,
  MAX_DYNAMIC_CSL_STYLES,
  normalizeEngineStyleId,
} from '@/modules/library/citation/domain/csl-style-registry';
import { CslRepositoryService } from './csl-repository.service';

export { BUILTIN_SPECIAL_STYLES, NUMERIC_STYLE_TOKENS, MAX_DYNAMIC_CSL_STYLES };

interface CitationJsTemplateStore {
  has(id: string): boolean;
  add(id: string, xml: string): void;
  remove?(id: string): void;
  delete?(id: string): boolean;
  data?: Record<string, string>;
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

@Injectable()
export class CslLocaleLoaderService {
  private readonly logger = new Logger(CslLocaleLoaderService.name);
  private templatesInitialized = false;
  private readonly staticTemplateIds = new Set<string>([
    'apa',
    'vancouver',
    'harvard1',
    'ieee',
    'nature',
    'chicago',
    'chicago-author-date',
    'mla',
    'mla-9th',
    'tcvn',
    'tcvn-author-date',
    'tcvn-numeric',
  ]);
  private readonly dynamicTemplateIds = new Set<string>();

  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
  ) {}

  private evictTemplateFromStore(
    templates: CitationJsTemplateStore,
    id: string,
  ): void {
    if (typeof templates.remove === 'function') {
      templates.remove(id);
    } else if (typeof templates.delete === 'function') {
      templates.delete(id);
    } else if (templates.data && typeof templates.data === 'object') {
      delete templates.data[id];
    }
  }

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
          this.staticTemplateIds.add(id);
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

  public async ensureTemplate(
    styleId: string,
    scopeId?: string,
    rawXml?: string,
  ): Promise<boolean> {
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized)) return true;

    try {
      const csl = plugins.config.get('@csl');
      if (
        csl?.templates?.has(normalized) &&
        !rawXml &&
        (!scopeId || this.staticTemplateIds.has(normalized))
      ) {
        if (!this.staticTemplateIds.has(normalized)) {
          this.dynamicTemplateIds.delete(normalized);
          this.dynamicTemplateIds.add(normalized);
        }
        return true;
      }

      const xml =
        rawXml ||
        (this.cslRepo
          ? await this.cslRepo.fetchCslXml(normalized, scopeId)
          : null);
      if (!xml && csl?.templates?.has(normalized)) {
        return true;
      }
      if (xml && csl?.templates) {
        if (
          !this.staticTemplateIds.has(normalized) &&
          this.dynamicTemplateIds.size >= MAX_DYNAMIC_CSL_STYLES
        ) {
          const oldestId = this.dynamicTemplateIds.values().next().value;
          if (oldestId) {
            this.dynamicTemplateIds.delete(oldestId);
            this.evictTemplateFromStore(csl.templates, oldestId);
          }
        }
        csl.templates.add(normalized, xml);
        if (!this.staticTemplateIds.has(normalized)) {
          this.dynamicTemplateIds.add(normalized);
        }
        this.logger.log(
          `Dynamically registered on-demand CSL template: "${normalized}"`,
        );
        return true;
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
    return normalizeEngineStyleId(styleId);
  }
}
