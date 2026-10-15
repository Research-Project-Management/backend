/**
 * backend/scripts/benchmark/legacy-api-engine.ts
 *
 * Implements the Legacy Architecture (External API-First Ingestion Pipeline):
 * - Delegates all metadata resolution to Remote Academic APIs (CrossRef, OpenAlex, arXiv).
 * - For Links: Dispatches query to CrossRef / OpenAlex / arXiv API.
 * - For PDFs: Extracts identifier from document and fetches full record from Remote APIs.
 */

import { extractText } from 'unpdf';
import { CrossRefProvider } from '../../src/modules/library/ingestion/providers/crossref.provider';
import { OpenAlexProvider } from '../../src/modules/library/ingestion/providers/openalex.provider';
import { ArxivProvider } from '../../src/modules/library/ingestion/providers/arxiv.provider';
import {
  normalizeDoi,
  normalizeArxivId,
} from '../../src/modules/library/ingestion/utils/metadata.domain';
import { ExtractedMetadata } from './types';

export class LegacyApiEngine {
  private static crossref = new CrossRefProvider();
  private static openalex = new OpenAlexProvider();
  private static arxiv = new ArxivProvider();

  /**
   * Resolves a Link via External Academic APIs (CrossRef / OpenAlex / arXiv)
   */
  static async resolveUrl(url: string): Promise<ExtractedMetadata> {
    const startedAt = Date.now();

    try {
      // 1. Check if URL contains DOI
      const doi =
        normalizeDoi(url) || url.match(/\b(10\.\d{4,9}\/[^\s?#]+)/)?.[1];
      if (doi) {
        // Query CrossRef API
        const crRes = await this.crossref.resolve({
          query: doi,
          queryType: 'DOI',
        });
        if (crRes?.metadata) {
          const m = crRes.metadata;
          return {
            title: m.title,
            doi: m.doi || doi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: m.publisher,
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_CROSSREF',
            executionMs: Date.now() - startedAt,
          };
        }

        // Fallback to OpenAlex API
        const oaRes = await this.openalex.resolve({
          query: doi,
          queryType: 'DOI',
        });
        if (oaRes?.metadata) {
          const m = oaRes.metadata;
          return {
            title: m.title,
            doi: m.doi || doi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: m.publisher,
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_OPENALEX',
            executionMs: Date.now() - startedAt,
          };
        }
      }

      // 2. Check if arXiv URL
      const arxivMatch = url.match(
        /arxiv\.org\/(?:abs|pdf)\/([0-9.]+v?[0-9]*)/i,
      );
      if (arxivMatch) {
        const arxivId = arxivMatch[1];
        const axRes = await this.arxiv.resolve({
          query: arxivId,
          queryType: 'ARXIV',
        });
        if (axRes?.metadata) {
          const m = axRes.metadata;
          return {
            title: m.title,
            doi: m.doi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: 'arXiv',
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_ARXIV',
            executionMs: Date.now() - startedAt,
          };
        }
      }

      // 3. Check if PubMed URL
      const pmidMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
      if (pmidMatch) {
        const pmid = pmidMatch[1];
        const oaRes = await this.openalex.resolve({
          query: pmid,
          queryType: 'PMID',
        });
        if (oaRes?.metadata) {
          const m = oaRes.metadata;
          return {
            title: m.title,
            doi: m.doi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: m.publisher,
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_OPENALEX_PMID',
            executionMs: Date.now() - startedAt,
          };
        }
      }

      // 4. Generic Title Search via OpenAlex API
      const searchRes = await this.openalex.resolve({
        query: url,
        queryType: 'TITLE',
      });
      if (searchRes?.metadata) {
        const m = searchRes.metadata;
        return {
          title: m.title,
          doi: m.doi,
          authors: m.authors,
          year: m.year ?? undefined,
          journal: m.journal,
          engineUsed: 'LEGACY_API_OPENALEX_SEARCH',
          executionMs: Date.now() - startedAt,
        };
      }

      return {
        engineUsed: 'LEGACY_API_NOT_FOUND',
        executionMs: Date.now() - startedAt,
        rawError: 'No matching record found in External APIs',
      };
    } catch (err: any) {
      return {
        engineUsed: 'LEGACY_API_ERROR',
        executionMs: Date.now() - startedAt,
        rawError: err?.message,
      };
    }
  }

  /**
   * Resolves a PDF by extracting minimal anchor (DOI/arXiv) and querying Remote APIs.
   * This is how the legacy system worked: PDF text dump -> find DOI -> call CrossRef/OpenAlex API.
   */
  static async resolvePdf(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<ExtractedMetadata> {
    const startedAt = Date.now();

    try {
      const cloned = new Uint8Array(buffer.byteLength);
      cloned.set(buffer);
      const rawResult = await extractText(cloned, { mergePages: false });
      const pages = Array.isArray(rawResult?.text)
        ? rawResult.text
        : [String(rawResult || '')];
      const headerText = (pages[0] || '') + '\n' + (pages[1] || '');

      // 1. Search for DOI pattern in text
      const doiMatch = headerText.match(
        /\b(10\.\d{4,9}\/[a-zA-Z0-9.\-_:;()/]+)/i,
      );
      let cleanDoi = doiMatch
        ? doiMatch[1].replace(/[.,;:)\]]+$/, '')
        : undefined;

      // 2. Search for arXiv pattern in text
      const arxivMatch = headerText.match(/arxiv:\s*([0-9.]+v?[0-9]*)/i);
      let cleanArxiv = arxivMatch ? arxivMatch[1] : undefined;

      // 3. Fallback: Search in filename
      if (!cleanDoi && preferredFilename) {
        const fnDoiMatch = preferredFilename.match(
          /10\.\d{4,9}[/_@][-._;()/:A-Za-z0-9]+/,
        );
        if (fnDoiMatch) {
          cleanDoi = fnDoiMatch[0]
            .replace(/^(10\.\d{4,9})[_@]/, '$1/')
            .replace(/[.,;:)\]]+$/, '');
        }
      }
      if (!cleanArxiv && preferredFilename) {
        const fnAxMatch = preferredFilename.match(
          /(?:arxiv[:_.-]*)?([0-2]\d{3}\.\d{4,5}(?:v\d+)?)/i,
        );
        if (fnAxMatch) cleanArxiv = fnAxMatch[1];
      }

      // Query by DOI
      if (cleanDoi) {
        const crRes = await this.crossref.resolve({
          query: cleanDoi,
          queryType: 'DOI',
        });
        if (crRes?.metadata) {
          const m = crRes.metadata;
          return {
            title: m.title,
            doi: m.doi || cleanDoi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: m.publisher,
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_CROSSREF',
            executionMs: Date.now() - startedAt,
          };
        }

        const oaRes = await this.openalex.resolve({
          query: cleanDoi,
          queryType: 'DOI',
        });
        if (oaRes?.metadata) {
          const m = oaRes.metadata;
          return {
            title: m.title,
            doi: m.doi || cleanDoi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: m.publisher,
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_OPENALEX',
            executionMs: Date.now() - startedAt,
          };
        }
      }

      // Query by arXiv ID
      if (cleanArxiv) {
        const axRes = await this.arxiv.resolve({
          query: cleanArxiv,
          queryType: 'ARXIV',
        });
        if (axRes?.metadata) {
          const m = axRes.metadata;
          return {
            title: m.title,
            doi: m.doi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: 'arXiv',
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_ARXIV',
            executionMs: Date.now() - startedAt,
          };
        }
      }

      // 4. Fallback: Search OpenAlex by Title candidate (Legacy EnrichStage behavior)
      let titleCandidate: string | undefined;
      if (preferredFilename) {
        const cleanedFn = preferredFilename
          .replace(/^paper_\d+_/i, '')
          .replace(/\.pdf$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim();
        if (cleanedFn.length > 5) titleCandidate = cleanedFn;
      }
      if (!titleCandidate && pages[0]) {
        const lines = pages[0]
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 8);
        if (lines.length > 0) titleCandidate = lines[0];
      }

      if (titleCandidate) {
        const oaTitleRes = await this.openalex.resolve({
          query: titleCandidate,
          queryType: 'TITLE',
        });
        if (oaTitleRes?.metadata) {
          const m = oaTitleRes.metadata;
          return {
            title: m.title,
            doi: m.doi,
            authors: m.authors,
            year: m.year ?? undefined,
            journal: m.journal,
            publisher: m.publisher,
            abstract: m.abstract,
            engineUsed: 'LEGACY_API_OPENALEX_TITLE',
            executionMs: Date.now() - startedAt,
          };
        }
      }

      return {
        engineUsed: 'LEGACY_API_NO_IDENTIFIER',
        executionMs: Date.now() - startedAt,
        rawError:
          'No DOI, arXiv, or title candidate found to query External APIs',
      };
    } catch (err: any) {
      return {
        engineUsed: 'LEGACY_API_ERROR',
        executionMs: Date.now() - startedAt,
        rawError: err?.message,
      };
    }
  }
}
