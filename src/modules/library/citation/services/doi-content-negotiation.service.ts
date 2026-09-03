import { Injectable, Logger } from '@nestjs/common';

export interface DoiCitationResult {
  styleId: string;
  bibliography: string;
  bibliographyHtml?: string;
  inText?: string;
  source: 'publisher';
}

@Injectable()
export class DoiContentNegotiationService {
  private readonly logger = new Logger(DoiContentNegotiationService.name);

  // In-memory cache with TTL (24 hours)
  private readonly cache = new Map<
    string,
    { result: DoiCitationResult; expiresAt: number }
  >();

  private readonly STYLE_ACCEPT_MAP: Record<string, string> = {
    apa: 'text/bibliography; style=apa',
    'apa-7th': 'text/bibliography; style=apa',
    ieee: 'text/bibliography; style=ieee',
    nature: 'text/bibliography; style=nature',
    chicago: 'text/bibliography; style=chicago-author-date',
    'chicago-author-date': 'text/bibliography; style=chicago-author-date',
    mla: 'text/bibliography; style=modern-language-association',
    'mla-9th': 'text/bibliography; style=modern-language-association',
    vancouver: 'text/bibliography; style=vancouver',
    harvard: 'text/bibliography; style=harvard-cite-them-right',
    bibtex: 'application/x-bibtex',
    ris: 'application/x-research-info-systems',
  };

  /**
   * Cleans and normalizes DOI string.
   */
  public cleanDoi(rawDoi?: string | null): string | null {
    if (!rawDoi || typeof rawDoi !== 'string') return null;
    const cleaned = rawDoi
      .trim()
      .replace(/^https?:\/\/doi\.org\//i, '')
      .replace(/^https?:\/\/dx\.doi\.org\//i, '')
      .replace(/^doi:\s*/i, '');
    return cleaned.match(/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/)
      ? cleaned
      : null;
  }

  /**
   * Resolves authoritative publisher-rendered citation directly from Crossref/DataCite.
   * Returns null if not resolvable or on timeout to allow graceful fallback.
   */
  async resolveCitation(
    rawDoi: string,
    styleId: string = 'apa',
    timeoutMs: number = 5000,
  ): Promise<DoiCitationResult | null> {
    const doi = this.cleanDoi(rawDoi);
    if (!doi) return null;

    const normalizedStyle = (styleId || 'apa').toLowerCase();
    const acceptHeader =
      this.STYLE_ACCEPT_MAP[normalizedStyle] || 'text/bibliography; style=apa';
    const cacheKey = `${doi}:${normalizedStyle}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(
        `https://doi.org/${encodeURIComponent(doi)}`,
        {
          headers: {
            Accept: acceptHeader,
            'User-Agent':
              'Flux-Academic-Research/1.0 (mailto:support@flux.study)',
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timer);

      if (!response.ok) {
        return null;
      }

      const rawText = await response.text();
      const cleanedText = rawText.trim();
      if (!cleanedText || cleanedText.startsWith('<!DOCTYPE html>')) {
        return null; // Received HTML error page rather than bibliography
      }

      // Generate HTML with linkified DOI if present
      const bibliographyHtml = this.formatBibliographyHtml(cleanedText, doi);

      const result: DoiCitationResult = {
        styleId: normalizedStyle,
        bibliography: cleanedText,
        bibliographyHtml,
        source: 'publisher',
      };

      // Cache for 24h
      this.cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });

      // Cleanup cache if too large
      if (this.cache.size > 2000) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }

      return result;
    } catch (err: any) {
      this.logger.debug(
        `DOI Content Negotiation bypassed for ${doi} (${normalizedStyle}): ${err?.message || err}`,
      );
      return null;
    }
  }

  private formatBibliographyHtml(text: string, doi: string): string {
    const doiUrl = `https://doi.org/${doi}`;
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Linkify DOI URL
    if (html.includes(doiUrl)) {
      html = html.replace(
        doiUrl,
        `<a href="${doiUrl}" target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80">${doiUrl}</a>`,
      );
    } else if (html.includes(`doi:${doi}`)) {
      html = html.replace(
        `doi:${doi}`,
        `<a href="${doiUrl}" target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80">doi:${doi}</a>`,
      );
    }

    return `<div class="csl-entry">${html}</div>`;
  }
}
