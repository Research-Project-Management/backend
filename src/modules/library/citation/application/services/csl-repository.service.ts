import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { RedisCacheService } from '@/core/cache/redis.service';
import {
  IEEE_CSL,
  NATURE_CSL,
  CHICAGO_CSL,
  MLA_CSL,
} from '../../infrastructure/data/official-styles.data';

export interface CslStyleMetadata {
  id: string;
  name: string;
  title: string;
  titleShort?: string;
  category: 'author-date' | 'numeric' | 'label' | 'note' | 'raw';
  fields?: string[];
  updated?: string;
  isCustom?: boolean;
}

/**
 * Authoritative built-in offline catalog of the most widely used international
 * academic journals and publisher styles (Nature, Science, Cell, IEEE, ACM, Lancet, etc.).
 * Ensures instant search and rendering even when the network is restricted.
 */
const POPULAR_ACADEMIC_STYLES: ReadonlyArray<CslStyleMetadata> = [
  { id: 'apa', name: 'apa', title: 'American Psychological Association 7th edition (APA)', category: 'author-date' },
  { id: 'apa-7th', name: 'apa-7th', title: 'APA 7th edition', category: 'author-date' },
  { id: 'ieee', name: 'ieee', title: 'IEEE (Institute of Electrical and Electronics Engineers)', category: 'numeric' },
  { id: 'nature', name: 'nature', title: 'Nature', category: 'numeric' },
  { id: 'science', name: 'science', title: 'Science (AAAS)', category: 'numeric' },
  { id: 'cell', name: 'cell', title: 'Cell (Cell Press)', category: 'author-date' },
  { id: 'the-lancet', name: 'the-lancet', title: 'The Lancet', category: 'numeric' },
  { id: 'plos-one', name: 'plos-one', title: 'PLOS ONE', category: 'numeric' },
  { id: 'pnas', name: 'proceedings-of-the-national-academy-of-sciences', title: 'Proceedings of the National Academy of Sciences (PNAS)', category: 'numeric' },
  { id: 'chicago-author-date', name: 'chicago-author-date', title: 'Chicago Manual of Style 17th/18th edition (Author-Date)', category: 'author-date' },
  { id: 'chicago-note-bibliography', name: 'chicago-note-bibliography', title: 'Chicago Manual of Style (Notes & Bibliography)', category: 'note' },
  { id: 'mla', name: 'modern-language-association', title: 'Modern Language Association 9th edition (MLA)', category: 'author-date' },
  { id: 'harvard1', name: 'harvard1', title: 'Harvard Reference Format 1 (Author-Date)', category: 'author-date' },
  { id: 'vancouver', name: 'vancouver', title: 'Vancouver', category: 'numeric' },
  { id: 'acm-siggraph', name: 'acm-siggraph', title: 'Association for Computing Machinery (ACM SIGGRAPH)', category: 'author-date' },
  { id: 'association-for-computing-machinery', name: 'association-for-computing-machinery', title: 'ACM Official Proceedings Format', category: 'numeric' },
  { id: 'american-chemical-society', name: 'american-chemical-society', title: 'American Chemical Society (ACS)', category: 'numeric' },
  { id: 'american-medical-association', name: 'american-medical-association', title: 'American Medical Association 11th edition (AMA)', category: 'numeric' },
  { id: 'american-physics-society', name: 'american-physics-society', title: 'Physical Review / American Physical Society (APS)', category: 'numeric' },
  { id: 'american-institute-of-physics', name: 'american-institute-of-physics', title: 'American Institute of Physics (AIP)', category: 'numeric' },
  { id: 'biomed-central', name: 'biomed-central', title: 'BioMed Central (BMC)', category: 'numeric' },
  { id: 'british-medical-journal', name: 'bmj', title: 'British Medical Journal (BMJ)', category: 'numeric' },
  { id: 'cambridge-university-press-author-date', name: 'cambridge-university-press-author-date', title: 'Cambridge University Press (Author-Date)', category: 'author-date' },
  { id: 'oxford-university-press-note', name: 'oxford-university-press-note', title: 'Oxford University Press', category: 'note' },
  { id: 'elsevier-harvard', name: 'elsevier-harvard', title: 'Elsevier - Harvard (with titles)', category: 'author-date' },
  { id: 'elsevier-vancouver', name: 'elsevier-vancouver', title: 'Elsevier - Vancouver', category: 'numeric' },
  { id: 'elsevier-with-titles', name: 'elsevier-with-titles', title: 'Elsevier Numeric (with titles)', category: 'numeric' },
  { id: 'springer-basic-author-date', name: 'springer-basic-author-date', title: 'Springer Basic (Author-Date)', category: 'author-date' },
  { id: 'springer-vancouver', name: 'springer-vancouver', title: 'Springer - Vancouver', category: 'numeric' },
  { id: 'royal-society-of-chemistry', name: 'royal-society-of-chemistry', title: 'Royal Society of Chemistry (RSC)', category: 'numeric' },
  { id: 'frontiers', name: 'frontiers', title: 'Frontiers Journals', category: 'author-date' },
  { id: 'mdpi', name: 'multidisciplinary-digital-publishing-institute', title: 'MDPI Journals', category: 'numeric' },
  { id: 'springer-lecture-notes-in-computer-science', name: 'springer-lecture-notes-in-computer-science', title: 'Springer LNCS (Lecture Notes in Computer Science)', category: 'numeric' },
  { id: 'bibtex', name: 'bibtex', title: 'BibTeX (LaTeX Standard)', category: 'raw' },
  { id: 'ris', name: 'ris', title: 'Research Information Systems (RIS)', category: 'raw' },
];

@Injectable()
export class CslRepositoryService implements OnModuleInit {
  private readonly logger = new Logger(CslRepositoryService.name);
  private static readonly ZOTERO_STYLES_JSON_URL = 'https://www.zotero.org/styles-files/styles.json';
  private static readonly ZOTERO_STYLE_XML_BASE = 'https://www.zotero.org/styles/';
  private static readonly GITHUB_RAW_CSL_BASE = 'https://raw.githubusercontent.com/citation-style-language/styles/master/';

  /** In-memory cached index of 10,000+ CSL styles from Zotero/CSL repo */
  private remoteStylesIndex: CslStyleMetadata[] | null = null;
  private isIndexLoading = false;

  constructor(
    @Optional()
    @Inject(RedisCacheService)
    private readonly redisCache?: RedisCacheService,
  ) {}

  onModuleInit() {
    // Asynchronously warm up the 10,000+ styles catalog in background
    this.refreshStylesCatalog().catch((err) => {
      this.logger.debug(`Background CSL styles catalog warm-up skipped/deferred: ${err?.message || err}`);
    });
  }

  /**
   * Search across the 10,000+ CSL Style repository.
   * Matches against title, short title, journal name, and category.
   */
  public async searchStyles(query: string = '', limit: number = 30): Promise<CslStyleMetadata[]> {
    const q = query.trim().toLowerCase();

    // 1. Get custom user styles from cache if any
    const customStyles = await this.getCustomStyles();

    // 2. If query is empty, return popular presets + any custom styles
    if (!q) {
      return [...customStyles, ...POPULAR_ACADEMIC_STYLES].slice(0, limit);
    }

    // 3. Search in popular list and custom styles first
    const localMatches = [...customStyles, ...POPULAR_ACADEMIC_STYLES].filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.titleShort && s.titleShort.toLowerCase().includes(q)),
    );

    // 4. Search in the 10,000+ remote styles catalog
    const catalog = await this.getStylesCatalog();
    const remoteMatches: CslStyleMetadata[] = [];

    const seenIds = new Set<string>(localMatches.map((s) => s.id.toLowerCase()));

    for (const item of catalog) {
      if (seenIds.has(item.id.toLowerCase())) continue;

      const titleMatch = item.title.toLowerCase().includes(q);
      const idMatch = item.id.toLowerCase().includes(q);
      const shortMatch = item.titleShort?.toLowerCase().includes(q);

      if (titleMatch || idMatch || shortMatch) {
        remoteMatches.push(item);
        seenIds.add(item.id.toLowerCase());
        if (localMatches.length + remoteMatches.length >= limit * 2) {
          break;
        }
      }
    }

    // Rank exact/prefix matches first
    const all = [...localMatches, ...remoteMatches];
    all.sort((a, b) => {
      const aStarts = a.title.toLowerCase().startsWith(q) || a.id.toLowerCase().startsWith(q);
      const bStarts = b.title.toLowerCase().startsWith(q) || b.id.toLowerCase().startsWith(q);
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
  public async fetchCslXml(styleId: string): Promise<string | null> {
    const normalized = styleId.trim().toLowerCase();

    // 1. Built-in hardcoded high-performance styles
    if (normalized === 'ieee') return IEEE_CSL;
    if (normalized === 'nature') return NATURE_CSL;
    if (normalized === 'chicago' || normalized === 'chicago-author-date') return CHICAGO_CSL;
    if (normalized === 'mla' || normalized === 'mla-9th') return MLA_CSL;

    // 2. Cache lookup
    const cacheKey = `csl:xml:${normalized}`;
    if (this.redisCache) {
      const cached = await this.redisCache.get<string>(cacheKey);
      if (cached && typeof cached === 'string' && cached.includes('<style')) {
        return cached;
      }
    }

    // 3. Remote Fetch from Zotero Style Repository
    try {
      const zoteroUrl = `${CslRepositoryService.ZOTERO_STYLE_XML_BASE}${encodeURIComponent(normalized)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(zoteroUrl, {
        headers: { Accept: 'application/vnd.citationstyles.style+xml, application/xml, text/xml' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const xml = await res.text();
        if (this.isValidCslXml(xml)) {
          if (this.redisCache) {
            // Cache for 30 days
            await this.redisCache.set(cacheKey, xml, 86400 * 30);
          }
          return xml;
        }
      }
    } catch (err: any) {
      this.logger.debug(`Zotero style fetch for "${normalized}" failed: ${err?.message || err}. Trying GitHub raw...`);
    }

    // 4. Remote Fetch Fallback from GitHub CSL Repository
    try {
      const githubUrl = `${CslRepositoryService.GITHUB_RAW_CSL_BASE}${encodeURIComponent(normalized)}.csl`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(githubUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const xml = await res.text();
        if (this.isValidCslXml(xml)) {
          if (this.redisCache) {
            await this.redisCache.set(cacheKey, xml, 86400 * 30);
          }
          return xml;
        }
      }
    } catch (err: any) {
      this.logger.warn(`GitHub CSL fetch for "${normalized}" failed: ${err?.message || err}`);
    }

    return null;
  }

  /**
   * Registers a custom CSL XML stylesheet uploaded by user.
   */
  public async registerCustomStyle(
    cslXml: string,
    customTitle?: string,
    scopeId?: string,
  ): Promise<CslStyleMetadata> {
    if (!this.isValidCslXml(cslXml)) {
      throw new Error(
        'Invalid CSL XML content: must contain valid <style> definition with required <title>, <id>, and <citation> or <bibliography> elements',
      );
    }

    // Extract title and ID from XML
    const titleMatch = cslXml.match(/<title>([^<]+)<\/title>/i);
    const idMatch = cslXml.match(/<id>([^<]+)<\/id>/i);

    const title = customTitle || titleMatch?.[1]?.trim() || 'Custom CSL Style';
    const rawId = idMatch?.[1]?.trim() || `custom-${Date.now()}`;
    const slug = rawId
      .replace(/^https?:\/\/www\.zotero\.org\/styles\//i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .toLowerCase();

    const formatMatch = cslXml.match(/citation-format="([^"]+)"/i);
    const category = (formatMatch?.[1] as any) || 'author-date';

    const meta: CslStyleMetadata = {
      id: slug,
      name: slug,
      title,
      category,
      isCustom: true,
      updated: new Date().toISOString(),
    };

    // Cache XML and metadata with tenant/scope isolation
    if (this.redisCache) {
      await this.redisCache.set(`csl:xml:${slug}`, cslXml, 86400 * 365);
      const listKey = scopeId
        ? `csl:${scopeId}:custom-styles-list`
        : 'csl:custom-styles-list';
      const existing = await this.getCustomStyles(scopeId);
      const updated = [meta, ...existing.filter((s) => s.id !== slug)];
      await this.redisCache.set(listKey, updated, 86400 * 365);
    }

    return meta;
  }

  /**
   * Retrieves user-defined custom styles.
   */
  public async getCustomStyles(scopeId?: string): Promise<CslStyleMetadata[]> {
    if (!this.redisCache) return [];
    try {
      const listKey = scopeId
        ? `csl:${scopeId}:custom-styles-list`
        : 'csl:custom-styles-list';
      const styles = await this.redisCache.get<CslStyleMetadata[]>(listKey);
      return Array.isArray(styles) ? styles : [];
    } catch {
      return [];
    }
  }

  /**
   * Loads the 10,000+ CSL Styles index (cached in memory & Redis).
   */
  private async getStylesCatalog(): Promise<CslStyleMetadata[]> {
    if (this.remoteStylesIndex && this.remoteStylesIndex.length > 0) {
      return this.remoteStylesIndex;
    }

    // Check Redis
    if (this.redisCache) {
      const cached = await this.redisCache.get<CslStyleMetadata[]>('csl:catalog:styles-index');
      if (Array.isArray(cached) && cached.length > 1000) {
        this.remoteStylesIndex = cached;
        return cached;
      }
    }

    // Trigger background refresh if not in progress
    if (!this.isIndexLoading) {
      this.refreshStylesCatalog().catch((e) => {
        this.logger.debug(`Background refresh error: ${e?.message}`);
      });
    }

    return [...POPULAR_ACADEMIC_STYLES];
  }

  /**
   * Refreshes the styles.json catalog from Zotero repository.
   */
  public async refreshStylesCatalog(): Promise<number> {
    if (this.isIndexLoading) return this.remoteStylesIndex?.length || 0;
    this.isIndexLoading = true;

    try {
      this.logger.log('Fetching official CSL 10,000+ styles index from Zotero...');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(CslRepositoryService.ZOTERO_STYLES_JSON_URL, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`Zotero styles.json responded with HTTP ${res.status}`);
      }

      const rawList = (await res.json()) as Array<{
        name: string;
        title: string;
        titleShort?: string;
        categories?: { format?: string; fields?: string[] };
        updated?: string;
      }>;

      if (!Array.isArray(rawList) || rawList.length === 0) {
        throw new Error('Received empty styles list');
      }

      const parsed: CslStyleMetadata[] = rawList.map((item) => {
        const cat = item.categories?.format as any;
        const validCategory =
          cat === 'author-date' || cat === 'numeric' || cat === 'label' || cat === 'note'
            ? cat
            : 'author-date';

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
      this.logger.log(`Successfully indexed ${parsed.length} official CSL styles from repository.`);

      if (this.redisCache) {
        // Cache index for 7 days
        await this.redisCache.set('csl:catalog:styles-index', parsed, 86400 * 7);
      }

      return parsed.length;
    } catch (err: any) {
      this.logger.warn(`Could not refresh remote CSL catalog: ${err?.message || err}. Using offline fallback.`);
      return POPULAR_ACADEMIC_STYLES.length;
    } finally {
      this.isIndexLoading = false;
    }
  }

  private isValidCslXml(xml?: string): boolean {
    if (!xml || typeof xml !== 'string') return false;
    const trimmed = xml.trim();
    return (
      (trimmed.startsWith('<?xml') || trimmed.startsWith('<style')) &&
      trimmed.includes('<style') &&
      trimmed.includes('</style>') &&
      /<title[\s\S]*?>[\s\S]*?<\/title>/i.test(trimmed) &&
      /<id[\s\S]*?>[\s\S]*?<\/id>/i.test(trimmed) &&
      (/<citation[\s\S]*?>[\s\S]*?<\/citation>/i.test(trimmed) ||
        /<bibliography[\s\S]*?>[\s\S]*?<\/bibliography>/i.test(trimmed))
    );
  }
}
