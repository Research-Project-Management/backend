/**
 * backend/scripts/benchmark/current-regex-engine.ts
 *
 * Implements the Current Architecture (Local-First / Zero-API / Academic Regex Engine):
 * - PDF: 4-Tier Zero-Network Cascade (XMP -> AcademicRegexCatalog -> LayoutHeuristics -> MeXtract).
 *        Completely offline, never calls any external API.
 * - Link: Direct HTML Regex metadata extraction (Highwire Press, Dublin Core, OpenGraph).
 *         Extracts directly from document source without third-party API dependencies.
 */

import { TrustedExtractionService } from '../../src/modules/library/extraction/services/trusted-extraction.service';
import { ExtractedMetadata } from './types';

export class CurrentRegexEngine {
  private static trustedExtractor = new TrustedExtractionService();

  /**
   * Current PDF Extraction: 100% Local-First / Zero-API Cascade
   */
  static async extractPdf(buffer: Buffer, preferredFilename?: string): Promise<ExtractedMetadata> {
    const startedAt = Date.now();
    try {
      const result = await this.trustedExtractor.extract(buffer, preferredFilename);
      const meta = result.metadata;

      return {
        title: meta.title,
        doi: meta.doi,
        authors: meta.authors,
        year: (meta.year !== null && meta.year !== undefined) ? meta.year : undefined,
        journal: meta.journal,
        publisher: meta.publisher,
        abstract: meta.abstract,
        engineUsed: `CURRENT_LOCAL_${result.provenance?.engineUsed || 'CASCADE'}`,
        executionMs: Date.now() - startedAt,
      };
    } catch (err: any) {
      return {
        engineUsed: 'CURRENT_LOCAL_ERROR',
        executionMs: Date.now() - startedAt,
        rawError: err?.message,
      };
    }
  }

  /**
   * Current Link Extraction: Direct Embedded Regex Extraction (Zero External API)
   * Scans HTML meta tags directly with regex without delegating to CrossRef / OpenAlex APIs.
   */
  static async extractUrl(url: string): Promise<ExtractedMetadata> {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return {
          engineUsed: 'CURRENT_REGEX_HTTP_FAIL',
          executionMs: Date.now() - startedAt,
          rawError: `HTTP ${res.status}`,
        };
      }

      const html = await res.text();

      // 1. Highwire Press & Dublin Core Regex Patterns
      const getMeta = (names: string[]): string | undefined => {
        for (const n of names) {
          const regex = new RegExp(
            `<meta\\s+[^>]*(?:name|property)=["']${n}["'][^>]*content=["']([^"']+)["']`,
            'i',
          );
          const match = html.match(regex);
          if (match) return match[1].trim();
        }
        return undefined;
      };

      const title =
        getMeta([
          'citation_title',
          'dc.title',
          'dcterms.title',
          'og:title',
        ]) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();

      const doi =
        getMeta(['citation_doi', 'dc.identifier', 'dc.doi', 'prism.doi']) ||
        html.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/i)?.[1];

      const pubDate = getMeta([
        'citation_publication_date',
        'citation_date',
        'dc.date',
        'prism.publicationDate',
      ]);
      let year: number | undefined;
      if (pubDate) {
        const yMatch = pubDate.match(/\b(19\d{2}|20\d{2})\b/);
        if (yMatch) year = parseInt(yMatch[1], 10);
      }

      const journal = getMeta([
        'citation_journal_title',
        'prism.publicationName',
        'citation_conference_title',
      ]);

      const authors: string[] = [];
      const authorRegex =
        /<meta\s+[^>]*(?:name|property)=["']citation_author["'][^>]*content=["']([^"']+)["']/gi;
      let aMatch: RegExpExecArray | null;
      while ((aMatch = authorRegex.exec(html)) !== null) {
        authors.push(aMatch[1].trim());
      }

      return {
        title,
        doi,
        year,
        journal,
        authors: authors.length > 0 ? authors : undefined,
        engineUsed: 'CURRENT_REGEX_HTML',
        executionMs: Date.now() - startedAt,
      };
    } catch (err: any) {
      return {
        engineUsed: 'CURRENT_REGEX_NET_ERR',
        executionMs: Date.now() - startedAt,
        rawError: err?.message,
      };
    }
  }
}
