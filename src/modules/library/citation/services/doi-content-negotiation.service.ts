import { Injectable, Logger } from '@nestjs/common';
import type { ReferenceData } from '../citation.service';
import {
  normalizeDoi,
  cleanBibliographicText,
} from '../../items/utils/items.utils';

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

  // In-memory metadata cache with TTL (24 hours)
  private readonly metaCache = new Map<
    string,
    { result: ReferenceData; expiresAt: number }
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
   * Cleans and normalizes DOI string according to ISO 26324.
   * Supports complex SICI strings, angle brackets, square brackets, plus, and equals signs.
   */
  public cleanDoi(rawDoi?: string | null): string | null {
    if (!rawDoi || typeof rawDoi !== 'string') return null;
    let clean = rawDoi.trim();
    clean = clean.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
    clean = clean.replace(/[.,;]+$/, '');
    if (clean.endsWith(')') && !clean.includes('(')) {
      clean = clean.slice(0, -1);
    }
    if (clean.endsWith(']') && !clean.includes('[')) {
      clean = clean.slice(0, -1);
    }
    const match = clean.match(/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+$/);
    if (!match) {
      const embedded = clean.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+/);
      return embedded ? embedded[0] : null;
    }
    return clean;
  }

  isDoi(raw: string): boolean {
    return Boolean(this.cleanDoi(raw));
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

  /**
   * Resolves full CSL-JSON metadata directly via DOI.org Content Negotiation.
   * Works for ALL registration agencies: CrossRef, DataCite (Zenodo, Figshare, Dryad), mEDRA, JaLC.
   */
  async resolveMetadata(
    rawDoi: string,
    timeoutMs: number = 6000,
  ): Promise<ReferenceData | null> {
    const doi = this.cleanDoi(rawDoi);
    if (!doi) return null;

    // Check metadata cache
    const cached = this.metaCache.get(doi);
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
            Accept:
              'application/vnd.citationstyles.csl+json, application/citeproc+json, application/json',
            'User-Agent':
              'Flux-Academic-Research/1.0 (mailto:support@flux.study)',
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timer);

      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) return null;

      const json = await response.json();
      if (!json || typeof json !== 'object') return null;

      const result = this.mapCslJsonToReferenceData(json, doi);
      if (!result || !result.title || result.title === 'Untitled') return null;

      // Cache metadata
      this.metaCache.set(doi, {
        result,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });

      if (this.metaCache.size > 2000) {
        const oldestKey = this.metaCache.keys().next().value;
        if (oldestKey) this.metaCache.delete(oldestKey);
      }

      return result;
    } catch (err: any) {
      this.logger.debug(
        `DOI Content Negotiation metadata resolution bypassed for ${doi}: ${err?.message || err}`,
      );
      return null;
    }
  }

  private mapCslJsonToReferenceData(
    rawCsl: Record<string, any>,
    fallbackDoi: string,
  ): ReferenceData {
    const csl =
      rawCsl.message && typeof rawCsl.message === 'object'
        ? rawCsl.message
        : rawCsl;

    const rawTitle = Array.isArray(csl.title)
      ? csl.title[0] || 'Untitled'
      : csl.title || 'Untitled';
    const title = cleanBibliographicText(rawTitle) || 'Untitled';

    const authors: string[] = [];
    if (Array.isArray(csl.author)) {
      for (const auth of csl.author) {
        if (auth.given && auth.family) {
          authors.push(`${auth.family}, ${auth.given}`);
        } else if (auth.family) {
          authors.push(auth.family);
        } else if (auth.name) {
          authors.push(auth.name);
        } else if (auth.literal) {
          authors.push(auth.literal);
        }
      }
    }

    let year: number | string = '';
    const dateParts =
      csl['published-print']?.['date-parts']?.[0] ||
      csl['published-online']?.['date-parts']?.[0] ||
      csl.issued?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) {
      year = Number(dateParts[0]);
    }

    const journal = Array.isArray(csl['container-title'])
      ? csl['container-title'][0]
      : csl['container-title'] || csl.publisher || '';

    const doi = csl.DOI || fallbackDoi;

    return {
      doi,
      title,
      authors,
      year,
      journal,
      publisher: csl.publisher || '',
      volume: csl.volume || '',
      issue: csl.issue || '',
      pages: csl.page || '',
      issn: Array.isArray(csl.ISSN) ? csl.ISSN[0] : csl.ISSN || '',
      isbn: Array.isArray(csl.ISBN) ? csl.ISBN[0] : csl.ISBN || '',
      url: csl.URL || (doi ? `https://doi.org/${doi}` : ''),
      abstract: csl.abstract ? csl.abstract.replace(/<[^>]*>/g, '') : '',
      type: csl.type || 'journal-article',
      itemType:
        csl.type === 'article-journal'
          ? 'journalArticle'
          : csl.type === 'dataset'
            ? 'dataset'
            : csl.type === 'paper-conference'
              ? 'conferencePaper'
              : csl.type === 'book'
                ? 'book'
                : 'journalArticle',
    };
  }
}
