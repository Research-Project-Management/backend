import { Injectable, Logger } from '@nestjs/common';

/**
 * Represents a single item returned by Zotero Translation Server.
 * Follows the Zotero/CSL-JSON item schema.
 * Docs: https://github.com/zotero/translation-server
 */
export interface ZoteroItem {
  itemType: string;
  title?: string;
  abstractNote?: string;
  url?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  date?: string;
  year?: number;
  publicationTitle?: string;
  journalAbbreviation?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  language?: string;
  rights?: string;
  shortTitle?: string;
  callNumber?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  extra?: string;
  tags?: Array<{ tag: string; type?: number }>;
  creators?: Array<{
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  seeAlso?: string[];
  collections?: string[];
  relations?: Record<string, string | string[]>;
  dateAdded?: string;
  dateModified?: string;
  key?: string;
  version?: number;
}

/**
 * HTTP client for Zotero Translation Server — 700+ academic publisher translators.
 *
 * Zotero Translation Server runs as a Docker sidecar (zotero/translation-server) on port 1969.
 * License: AGPLv3 — safe as separate Docker service (no license contagion via HTTP boundary).
 * Docs: https://github.com/zotero/translation-server
 *
 * Powers Wikipedia Citoid — battle-tested at scale.
 */
@Injectable()
export class ZoteroTranslatorClient {
  private readonly logger = new Logger(ZoteroTranslatorClient.name);

  private get baseUrl(): string {
    return process.env.ZOTERO_TRANSLATOR_URL?.replace(/\/$/, '') ?? 'http://localhost:1969';
  }

  private get enabled(): boolean {
    const val = process.env.ZOTERO_TRANSLATOR_ENABLED;
    return val !== 'false' && val !== '0';
  }

  private readonly timeoutMs = 12_000;
  private readonly userAgent = 'FluxResearchPlatform/1.0 (contact@flux.app)';

  /**
   * Translates a URL into structured Zotero/CSL-JSON metadata.
   *
   * POST /web {"url": "https://..."}
   * Returns array of ZoteroItem (usually 1 item).
   * Returns empty array if Zotero TS is disabled, unreachable, or URL has no translator.
   *
   * Caller is responsible for SSRF pre-validation before calling this method.
   */
  async translateUrl(url: string): Promise<ZoteroItem[]> {
    if (!this.enabled) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/web`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': this.userAgent,
        },
        body: url,
        signal: controller.signal,
      });


      if (response.status === 300) {
        // Multiple choices — try to pick the first option
        const body = await response.json().catch(() => null);
        if (body?.items && typeof body.items === 'object') {
          const firstKey = Object.keys(body.items)[0];
          if (firstKey) {
            return this.selectItem(url, firstKey);
          }
        }
        return [];
      }

      if (!response.ok) {
        if (response.status === 501) {
          // No translator found for this URL — not an error
          this.logger.debug(`Zotero: no translator for URL ${url} (501)`);
        } else {
          this.logger.warn(`Zotero Translation Server returned HTTP ${response.status} for ${url}`);
        }
        return [];
      }

      const items = await response.json();
      if (!Array.isArray(items)) return [];
      return items as ZoteroItem[];
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.logger.warn(`Zotero Translation Server timed out for URL: ${url}`);
      } else {
        this.logger.warn(`Zotero Translation Server unavailable: ${err?.message}`);
      }
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Handles 300 Multiple Choices response by selecting a specific item.
   * Used when a page has multiple extractable items (e.g. search results page).
   */
  private async selectItem(url: string, selectedKey: string): Promise<ZoteroItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/web`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify({ url, items: { [selectedKey]: selectedKey } }),
        signal: controller.signal,
      });

      if (!response.ok) return [];
      const items = await response.json();
      return Array.isArray(items) ? (items as ZoteroItem[]) : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check — returns true if Zotero Translation Server is alive.
   */
  async isAlive(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${this.baseUrl}/`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Translation server returns 404 on GET / because it only routes POST endpoints.
      // Receiving any HTTP response status means the server is alive and listening.
      return response.status > 0;
    } catch {
      return false;
    }
  }

}
