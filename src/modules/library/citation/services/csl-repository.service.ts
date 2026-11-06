import { createHash } from 'crypto';
import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { RedisCacheService } from '@/core';
import {
  HttpClient,
  ExtractionProcessException,
  ExternalProviderException,
  LIBRARY_REDIS_KEYS,
  SingleFlightCoalescer,
} from '@/modules/library/core';
import { ExportsRepository } from '../repositories/exports.repository';
import {
  IEEE_CSL,
  NATURE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
  VI_VN_LOCALE,
} from '@/modules/library/citation/domain/official-styles.lexicon';
import {
  BUILTIN_SPECIAL_STYLES,
  MAX_DYNAMIC_CSL_STYLES,
  normalizeEngineStyleId,
} from '@/modules/library/citation/domain/citation.domain';

import {
  CslStyleMetadata,
  parseCslCategory,
  POPULAR_STYLES,
  REMOTE_STYLE_SLUG_ALIASES,
} from '@/modules/library/citation/domain/csl-styles.lexicon';

export type { CslStyleMetadata };
export { POPULAR_STYLES, REMOTE_STYLE_SLUG_ALIASES };

@Injectable()
export class CslRepositoryService implements OnModuleInit {
  private readonly logger = new Logger(CslRepositoryService.name);
  private static readonly ZOTERO_STYLES_JSON_URL =
    'https://www.zotero.org/styles-files/styles.json';
  private static readonly ZOTERO_STYLE_XML_BASE =
    'https://www.zotero.org/styles/';
  private static readonly GITHUB_RAW_CSL_BASE =
    'https://raw.githubusercontent.com/citation-style-language/styles/master/';

  private static readonly REMOTE_INDEX_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly MAX_CUSTOM_STYLES_PER_SCOPE = 100;

  /** In-memory cached index of 10,000+ CSL styles from Zotero/CSL repo */
  private remoteStylesIndex: CslStyleMetadata[] | null = null;
  private remoteStylesIndexExpiresAt = 0;
  private readonly singleFlight = new SingleFlightCoalescer();

  constructor(
    @Optional()
    @Inject(RedisCacheService)
    private readonly redisCache?: RedisCacheService,
    @Optional()
    private readonly httpClient?: HttpClient,
    @Optional()
    private readonly exportsRepo?: ExportsRepository,
  ) {}

  onModuleInit() {
    this.logger.log(
      `CSL Repository initialized with ${POPULAR_STYLES.length} popular academic styles (remote 10,000+ catalog lazy-loaded on demand).`,
    );
  }

  /**
   * Search across the 10,000+ CSL Style repository.
   * Matches against title, short title, journal name, and category.
   */
  public async searchStyles(
    query: string = '',
    limit: number = 30,
    scopeId?: string,
  ): Promise<CslStyleMetadata[]> {
    const q = query.trim().toLowerCase();

    // 1. Get custom user styles from cache if any
    const customStyles = await this.getCustomStyles(scopeId);

    // 2. If query is empty, return popular presets + any custom styles
    if (!q) {
      return [...customStyles, ...POPULAR_STYLES].slice(0, limit);
    }

    // 3. Search in popular list and custom styles first
    const localMatches = [...customStyles, ...POPULAR_STYLES].filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.titleShort && s.titleShort.toLowerCase().includes(q)),
    );

    // Fast-path: If local popular matches satisfy the limit, return immediately without loading 10,000 remote styles
    if (localMatches.length >= limit) {
      return localMatches.slice(0, limit);
    }

    // 4. Search in the 10,000+ remote styles catalog
    const catalog = await this.getStylesCatalog();
    const remoteMatches: CslStyleMetadata[] = [];

    const seenIds = new Set<string>();
    for (const s of localMatches) {
      seenIds.add(s.id.toLowerCase());
      if (s.name) seenIds.add(s.name.toLowerCase());
    }

    for (const item of catalog) {
      const lowerId = item.id.toLowerCase();
      const lowerName = item.name?.toLowerCase() || lowerId;
      if (seenIds.has(lowerId) || seenIds.has(lowerName)) continue;

      const titleMatch = item.title.toLowerCase().includes(q);
      const idMatch = lowerId.includes(q);
      const shortMatch = item.titleShort?.toLowerCase().includes(q);

      if (titleMatch || idMatch || shortMatch) {
        remoteMatches.push(item);
        seenIds.add(lowerId);
        seenIds.add(lowerName);
        if (localMatches.length + remoteMatches.length >= limit * 2) {
          break;
        }
      }
    }

    // Rank exact/prefix matches first
    const all = [...localMatches, ...remoteMatches];
    all.sort((a, b) => {
      const aStarts =
        a.title.toLowerCase().startsWith(q) || a.id.toLowerCase().startsWith(q);
      const bStarts =
        b.title.toLowerCase().startsWith(q) || b.id.toLowerCase().startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.title.localeCompare(b.title);
    });

    return all.slice(0, limit);
  }

  /**
   * Fetches official CSL XML stylesheet content for the given styleId.
   * Checks:
   * 1. In-process official static data (IEEE, Nature, Chicago, MLA)
   * 2. Redis/Memory Cache
   * 3. Zotero Style Repository API (https://www.zotero.org/styles/:styleId)
   * 4. GitHub CSL Repository Raw Fallback
   */
  public async fetchCslXml(
    styleId: string,
    scopeId?: string,
    depth: number = 0,
  ): Promise<string | null> {
    if (depth > 2) return null;
    const rawNormalized = styleId.trim().toLowerCase();
    const normalized = REMOTE_STYLE_SLUG_ALIASES[rawNormalized] ?? rawNormalized;
    if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(normalized)) {
      return null;
    }
    const cacheKey = LIBRARY_REDIS_KEYS.cslStyleXml(normalized);

    // 1. Built-in bundled high-performance styles
    if (normalized === 'ieee') return IEEE_CSL;
    if (normalized === 'nature') return NATURE_CSL;
    if (normalized === 'chicago' || normalized === 'chicago-author-date') return CHICAGO_CSL;
    if (normalized === 'mla' || normalized === 'mla-9th' || normalized === 'modern-language-association') return MLA_CSL;

    // 2. Cache & DB lookup (scoped custom style lookup first, then global official cache)
    const scopeKey = scopeId?.trim() || 'global';
    if (this.redisCache) {
      const scoped = await this.redisCache.get<string>(LIBRARY_REDIS_KEYS.cslStyleXml(normalized, scopeKey));
      if (scoped && typeof scoped === 'string' && scoped.includes('<style')) return scoped;
      if (!scopeId) {
        const legacyCustom = await this.redisCache.get<string>(LIBRARY_REDIS_KEYS.cslStyleXml(normalized, 'custom'));
        if (legacyCustom && typeof legacyCustom === 'string' && legacyCustom.includes('<style')) return legacyCustom;
      }
      const cached = await this.redisCache.get<string>(cacheKey);
      if (cached && typeof cached === 'string' && cached.includes('<style')) return cached;
    }

    if (this.exportsRepo) {
      try {
        const dbRow = await this.exportsRepo.findCustomStyle(scopeKey, normalized);
        if (dbRow?.xmlContent && dbRow.xmlContent.includes('<style')) {
          if (this.redisCache) {
            await this.redisCache.set(LIBRARY_REDIS_KEYS.cslStyleXml(normalized, scopeKey), dbRow.xmlContent, 86400 * 365);
          }
          return dbRow.xmlContent;
        }
      } catch {
        // Non-fatal fallback
      }
    }

    const resolveOrValidateFetchedXml = async (xml: string): Promise<string | null> => {
      if (this.isValidCslXml(xml)) {
        if (this.redisCache) await this.redisCache.set(cacheKey, xml, 86400 * 30);
        return xml;
      }
      const parentSlug = this.extractDependentParentSlug(xml);
      if (parentSlug && parentSlug !== normalized) {
        const parentXml = await this.fetchCslXml(parentSlug, scopeId, depth + 1);
        if (parentXml && this.isValidCslXml(parentXml)) {
          if (this.redisCache) await this.redisCache.set(cacheKey, parentXml, 86400 * 30);
          return parentXml;
        }
      }
      return null;
    };

    return this.singleFlight.execute(`xml:${scopeKey}:${normalized}:${depth}`, async () => {
      // 3. Remote Fetch from Zotero Style Repository
      try {
        const zoteroUrl = `${CslRepositoryService.ZOTERO_STYLE_XML_BASE}${encodeURIComponent(normalized)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const headers = { Accept: 'application/vnd.citationstyles.style+xml, application/xml, text/xml' };
        const res = this.httpClient
          ? (await this.httpClient.request(zoteroUrl, { headers, signal: controller.signal, timeoutMs: 6000 })).response
          : await fetch(zoteroUrl, { headers, signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const resolved = await resolveOrValidateFetchedXml(await res.text());
          if (resolved) return resolved;
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } catch (err: unknown) {
        this.logger.debug(`Zotero style fetch for "${normalized}" failed: ${err instanceof Error ? err.message : String(err)}. Trying GitHub raw...`);
      }

      // 4. Remote Fetch Fallback from GitHub CSL Repository
      try {
        const githubUrl = `${CslRepositoryService.GITHUB_RAW_CSL_BASE}${encodeURIComponent(normalized)}.csl`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = this.httpClient
          ? (await this.httpClient.request(githubUrl, { signal: controller.signal, timeoutMs: 6000 })).response
          : await fetch(githubUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const resolved = await resolveOrValidateFetchedXml(await res.text());
          if (resolved) return resolved;
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } catch (err: unknown) {
        this.logger.warn(`GitHub CSL fetch for "${normalized}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      return null;
    });
  }

  /**
   * Registers a custom CSL XML stylesheet uploaded by user.
   */
  public async registerCustomStyle(
    cslXml: string,
    customTitle?: string,
    scopeId?: string,
  ): Promise<CslStyleMetadata> {
    if (!cslXml || typeof cslXml !== 'string' || cslXml.length > 512 * 1024) {
      throw new ExtractionProcessException(
        'Invalid CSL XML content: must be a non-empty string under 512KB',
        { cslXmlLength: typeof cslXml === 'string' ? cslXml.length : 0 },
      );
    }
    if (!this.isValidCslXml(cslXml)) {
      throw new ExtractionProcessException(
        'Invalid CSL XML content: must contain valid <style> definition with required <title>, <id>, and <citation> or <bibliography> elements',
      );
    }

    const titleMatch = cslXml.match(/<title>([^<]+)<\/title>/i);
    const idMatch = cslXml.match(/<id>([^<]+)<\/id>/i);
    const rawTitle = customTitle || titleMatch?.[1]?.trim() || 'Custom CSL Style';
    const title = rawTitle.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 200) || 'Custom CSL Style';
    const rawId = idMatch?.[1]?.trim() || `custom-${Date.now()}`;
    const slug = rawId.replace(/^https?:\/\/www\.zotero\.org\/styles\//i, '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();

    const RESERVED_OFFICIAL_STYLES = new Set([
      'ieee', 'nature', 'science', 'chicago', 'chicago-author-date', 'mla', 'mla-9th',
      'apa', 'apa-7th', 'vancouver', 'harvard', 'harvard1', 'harvard-cite-them-right',
      'bibtex', 'ris', 'cell', 'the-lancet', 'plos', 'plos-one', 'pnas', 'frontiers',
      'springer', 'elsevier', 'tcvn', 'tcvn-author-date', 'tcvn-numeric',
      'bo-giao-duc', 'vietnam', 'auto', 'auto-numeric',
    ]);
    const normalizedEngineId = normalizeEngineStyleId(slug);
    if (RESERVED_OFFICIAL_STYLES.has(slug) || RESERVED_OFFICIAL_STYLES.has(normalizedEngineId)) {
      throw new ExtractionProcessException(`Cannot overwrite official built-in or standard CSL style ID: '${slug}'`);
    }

    const formatMatch = cslXml.match(/citation-format="([^"]+)"/i);
    const category = parseCslCategory(formatMatch?.[1]);
    const meta: CslStyleMetadata = { id: slug, name: slug, title, category, isCustom: true, updated: new Date().toISOString() };
    const scopeKey = scopeId?.trim() || 'global';
    const sha256 = createHash('sha256').update(cslXml).digest('hex');

    if (this.exportsRepo) {
      try {
        await this.exportsRepo.upsertCustomStyle({ scopeKey, slug, title, xmlContent: cslXml, sha256 });
      } catch (dbErr: unknown) {
        this.logger.warn(`Could not persist custom CSL style "${slug}" to DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
      }
    }

    if (this.redisCache) {
      const xmlKey = LIBRARY_REDIS_KEYS.cslStyleXml(slug, scopeKey);
      const listKey = LIBRARY_REDIS_KEYS.cslCustomStylesList(scopeKey);
      const [, existing] = await Promise.all([
        this.redisCache.set(xmlKey, cslXml, 86400 * 365),
        this.getCustomStyles(scopeKey),
      ]);
      const updated = [meta, ...existing.filter((s) => s.id !== slug)].slice(0, CslRepositoryService.MAX_CUSTOM_STYLES_PER_SCOPE);
      await this.redisCache.set(listKey, updated, 86400 * 365);
    }

    return meta;
  }

  /**
   * Retrieves user-defined custom styles.
   */
  public async getCustomStyles(scopeId?: string): Promise<CslStyleMetadata[]> {
    const scopeKey = scopeId?.trim() || 'global';
    if (this.redisCache) {
      try {
        const listKey = LIBRARY_REDIS_KEYS.cslCustomStylesList(scopeKey);
        const styles = await this.redisCache.get<CslStyleMetadata[]>(listKey);
        if (Array.isArray(styles) && styles.length > 0) {
          return styles.slice(0, CslRepositoryService.MAX_CUSTOM_STYLES_PER_SCOPE);
        }
      } catch {
        // Fallback to DB
      }
    }
    if (this.exportsRepo) {
      try {
        const rows = await this.exportsRepo.findCustomStylesByScope(scopeKey, CslRepositoryService.MAX_CUSTOM_STYLES_PER_SCOPE);
        const mapped: CslStyleMetadata[] = rows.map((r) => ({
          id: r.slug,
          name: r.slug,
          title: r.title,
          category: 'author-date',
          isCustom: true,
          updated: r.updatedAt.toISOString(),
        }));
        if (mapped.length > 0 && this.redisCache) {
          await this.redisCache.set(LIBRARY_REDIS_KEYS.cslCustomStylesList(scopeKey), mapped, 86400 * 365);
        }
        return mapped;
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Loads the 10,000+ CSL Styles index (cached in memory & Redis).
   */
  private async getStylesCatalog(): Promise<CslStyleMetadata[]> {
    const now = Date.now();
    if (
      this.remoteStylesIndex &&
      this.remoteStylesIndex.length > 0 &&
      now < this.remoteStylesIndexExpiresAt
    ) {
      return this.remoteStylesIndex;
    }

    // Check Redis
    if (this.redisCache) {
      const cached = await this.redisCache.get<CslStyleMetadata[]>(
        LIBRARY_REDIS_KEYS.cslStylesCatalogIndex(),
      );
      if (Array.isArray(cached) && cached.length > 1000) {
        this.remoteStylesIndex = cached;
        this.remoteStylesIndexExpiresAt =
          now + CslRepositoryService.REMOTE_INDEX_TTL_MS;
        return cached;
      }
    }

    // Trigger on-demand refresh coalesced via SingleFlight so concurrent callers await the same load
    try {
      await this.refreshStylesCatalog();
      if (this.remoteStylesIndex && this.remoteStylesIndex.length > 0) {
        return this.remoteStylesIndex;
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.debug(`On-demand CSL refresh error: ${errMsg}`);
    }

    return [...POPULAR_STYLES];
  }

  /**
   * Refreshes the styles.json catalog from Zotero repository.
   */
  public async refreshStylesCatalog(): Promise<number> {
    return this.singleFlight.execute('catalog:styles.json', async () => {
      try {
        this.logger.log(
          'Fetching official CSL 10,000+ styles index from Zotero...',
        );
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);

        const res = this.httpClient
          ? (
              await this.httpClient.request(
                CslRepositoryService.ZOTERO_STYLES_JSON_URL,
                { signal: controller.signal, timeoutMs: 12000 },
              )
            ).response
          : await fetch(CslRepositoryService.ZOTERO_STYLES_JSON_URL, {
              signal: controller.signal,
            });
        clearTimeout(timeout);

        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new ExternalProviderException(
            `Zotero styles.json responded with HTTP ${res.status}`,
            {
              url: CslRepositoryService.ZOTERO_STYLES_JSON_URL,
              status: res.status,
            },
          );
        }

        const rawList = (await res.json()) as Array<{
          name: string;
          title: string;
          titleShort?: string;
          categories?: { format?: string; fields?: string[] };
          updated?: string;
        }>;

        if (!Array.isArray(rawList) || rawList.length === 0) {
          throw new ExternalProviderException('Received empty styles list', {
            url: CslRepositoryService.ZOTERO_STYLES_JSON_URL,
          });
        }

        const parsed: CslStyleMetadata[] = rawList.map((item) => {
          const validCategory = parseCslCategory(item.categories?.format);

          return {
            id: item.name,
            name: item.name,
            title: item.title,
            titleShort: item.titleShort,
            category: validCategory,
            fields: item.categories?.fields,
            updated: item.updated,
          };
        });

        this.remoteStylesIndex = parsed;
        this.remoteStylesIndexExpiresAt =
          Date.now() + CslRepositoryService.REMOTE_INDEX_TTL_MS;
        this.logger.log(
          `Successfully indexed ${parsed.length} official CSL styles from repository.`,
        );

        if (this.redisCache) {
          // Cache index for 7 days
          await this.redisCache.set(
            LIBRARY_REDIS_KEYS.cslStylesCatalogIndex(),
            parsed,
            86400 * 7,
          );
        }

        return parsed.length;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not refresh remote CSL catalog: ${errMsg}. Using offline fallback.`,
        );
        return POPULAR_STYLES.length;
      }
    });
  }

  private extractDependentParentSlug(xml?: string): string | null {
    if (!xml || typeof xml !== 'string') return null;
    const linkTags = xml.match(/<link\b[^>]*>/gi);
    if (!linkTags) return null;
    for (const tag of linkTags) {
      if (!/\brel\s*=\s*["']independent-parent["']/i.test(tag)) continue;
      const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
      const href = hrefMatch?.[1]?.trim();
      if (!href) continue;
      const slug = href
        .replace(/^https?:\/\/(?:www\.)?zotero\.org\/styles\//i, '')
        .replace(/\.csl$/i, '')
        .trim()
        .toLowerCase();
      if (/^[a-z0-9][a-z0-9._-]{0,100}$/.test(slug)) {
        return slug;
      }
    }
    return null;
  }

  private isValidCslXml(xml?: string): boolean {
    if (!xml || typeof xml !== 'string') return false;
    if (xml.length > 512 * 1024) return false;
    const trimmed = xml.trim();
    if (!trimmed || trimmed.length > 512 * 1024) return false;
    if (/<!(?:doctype|entity)\b|<script\b/i.test(trimmed)) return false;
    const lower = trimmed.toLowerCase();
    return (
      (lower.startsWith('<?xml') || lower.startsWith('<style')) &&
      lower.includes('<style') &&
      lower.includes('</style>') &&
      (lower.includes('<info') ||
        (lower.includes('<title') &&
          lower.includes('</title>') &&
          lower.includes('<id') &&
          lower.includes('</id>'))) &&
      lower.includes('<title') &&
      lower.includes('</title>') &&
      lower.includes('<id') &&
      lower.includes('</id>') &&
      ((lower.includes('<citation') && lower.includes('</citation>')) ||
        (lower.includes('<bibliography') && lower.includes('</bibliography>')))
    );
  }
}

interface CitationJsTemplateStore {
  has(id: string): boolean;
  add(id: string, xml: string): void;
  get?(id: string): string | undefined;
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
  config: { get(name: string): CitationJsPluginConfig | undefined };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { plugins } = require('@citation-js/core') as { plugins: CitationJsPlugins };
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-csl');

@Injectable()
export class CslLocaleLoaderService {
  private readonly logger = new Logger(CslLocaleLoaderService.name);
  private templatesInitialized = false;
  private readonly staticTemplateIds = new Set<string>([
    'apa', 'vancouver', 'harvard1', 'ieee', 'nature', 'chicago',
    'chicago-author-date', 'mla', 'mla-9th', 'tcvn', 'tcvn-author-date', 'tcvn-numeric',
  ]);
  private readonly dynamicTemplateIds = new Set<string>();
  private readonly templateDigestMap = new Map<string, string>();

  constructor(
    @Optional()
    @Inject(CslRepositoryService)
    private readonly cslRepo?: CslRepositoryService,
  ) {}

  public getTemplateDigest(scopedStyleId: string): string {
    return this.templateDigestMap.get(scopedStyleId) || '';
  }

  private evictTemplateFromStore(templates: CitationJsTemplateStore, id: string): void {
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
      if (bibtexConfig?.format) bibtexConfig.format.useIdAsLabel = true;
      const csl = plugins.config.get('@csl');
      if (csl?.templates) {
        const templateBindings: ReadonlyArray<[string, string]> = [
          ['ieee', IEEE_CSL],
          ['nature', NATURE_CSL],
          ['chicago', CHICAGO_CSL],
          ['chicago-author-date', CHICAGO_CSL],
          ['mla', MLA_CSL],
          ['mla-9th', MLA_CSL],
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

  public getScopedStyleId(styleId: string, scopeId?: string): string {
    const normalized = this.normalizeStyle(styleId);
    if (this.staticTemplateIds.has(normalized) || BUILTIN_SPECIAL_STYLES.has(normalized)) {
      return normalized;
    }
    const scopeKey = scopeId?.trim() || 'global';
    return `${scopeKey}::${normalized}`;
  }

  public isStyleSupported(styleId: string, scopeId?: string): boolean {
    if (!styleId) return false;
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized)) return true;
    const scopedId = this.getScopedStyleId(normalized, scopeId);
    try {
      const csl = plugins.config.get('@csl');
      return Boolean(csl?.templates?.has(scopedId));
    } catch {
      return false;
    }
  }

  public async ensureTemplate(styleId: string, scopeId?: string, rawXml?: string): Promise<boolean> {
    this.initTemplates();
    const normalized = this.normalizeStyle(styleId);
    if (BUILTIN_SPECIAL_STYLES.has(normalized) || this.staticTemplateIds.has(normalized)) return true;
    const scopedId = this.getScopedStyleId(normalized, scopeId);
    try {
      const csl = plugins.config.get('@csl');
      if (csl?.templates?.has(scopedId) && !rawXml) {
        this.dynamicTemplateIds.delete(scopedId);
        this.dynamicTemplateIds.add(scopedId);
        return true;
      }
      const xml = rawXml || (this.cslRepo ? await this.cslRepo.fetchCslXml(normalized, scopeId) : null);
      if (!xml) return false;
      if (csl?.templates) {
        if (this.dynamicTemplateIds.size >= MAX_DYNAMIC_CSL_STYLES) {
          const oldestId = this.dynamicTemplateIds.values().next().value;
          if (oldestId) {
            this.dynamicTemplateIds.delete(oldestId);
            this.evictTemplateFromStore(csl.templates, oldestId);
          }
        }
        csl.templates.add(scopedId, xml);
        this.dynamicTemplateIds.add(scopedId);
        this.templateDigestMap.set(
          scopedId,
          createHash('sha256').update(xml).digest('hex').slice(0, 12),
        );
        this.logger.log(`Dynamically registered on-demand scoped CSL template: "${scopedId}"`);
        return true;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not dynamically load CSL template for "${scopedId}": ${errMsg}`);
    }
    return false;
  }

  public normalizeStyle(styleId: string): string {
    return normalizeEngineStyleId(styleId);
  }

  public getStyleDefaultLocale(styleId: string, scopeId?: string): string {
    this.initTemplates();
    const scopedId = this.getScopedStyleId(styleId, scopeId);
    try {
      const csl = plugins.config.get('@csl');
      const xml =
        typeof csl?.templates?.get === 'function'
          ? csl.templates.get(scopedId)
          : csl?.templates?.data?.[scopedId];
      if (typeof xml === 'string') {
        const match = xml.match(/\bdefault-locale\s*=\s*["']([^"']+)["']/i);
        if (match?.[1]?.trim()) return match[1].trim();
      }
    } catch {
      // Fallback to en-US
    }
    return 'en-US';
  }
}
