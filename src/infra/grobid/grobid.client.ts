import { Injectable, Logger } from '@nestjs/common';

export interface GrobidHeaderResult {
  title?: string;
  authors?: string[];
  abstract?: string;
  doi?: string;
  arxivId?: string;
  year?: number;
  journal?: string;
  keywords?: string[];
  affiliations?: string[];
}

/**
 * HTTP client for GROBID — ML-based structured academic PDF extraction.
 * GROBID runs as a Docker sidecar (lfoppiano/grobid:0.8.2-crf) on port 8070.
 *
 * License: Apache 2.0 (safe for commercial SaaS)
 * Docs: https://grobid.readthedocs.io/en/latest/Grobid-service/
 *
 * Gracefully disabled if GROBID_ENABLED=false or sidecar is unreachable.
 */
@Injectable()
export class GrobidClient {
  private readonly logger = new Logger(GrobidClient.name);

  private get baseUrl(): string {
    return process.env.GROBID_URL?.replace(/\/$/, '') ?? 'http://localhost:8070';
  }

  private get enabled(): boolean {
    const val = process.env.GROBID_ENABLED;
    // Default enabled if env not set (opt-out model)
    return val !== 'false' && val !== '0';
  }

  private readonly timeoutMs = 15_000;

  /**
   * Extracts structured header metadata from a PDF buffer.
   * Sends to GROBID /api/processHeaderDocument → TEI XML → parsed result.
   * Returns null if GROBID is disabled, down, or returns non-200.
   */
  async processHeaderDocument(buffer: Buffer): Promise<GrobidHeaderResult | null> {
    if (!this.enabled) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const formData = new FormData();
      formData.append(
        'input',
        new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
        'document.pdf',
      );
      formData.append('consolidateHeader', '0'); // No CrossRef consolidation (we have our own)

      const response = await fetch(`${this.baseUrl}/api/processHeaderDocument`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `GROBID processHeaderDocument returned HTTP ${response.status} — skipping enrichment`,
        );
        return null;
      }

      const teiXml = await response.text();
      return this.parseTeiHeader(teiXml);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.logger.warn('GROBID processHeaderDocument timed out — skipping enrichment');
      } else {
        this.logger.warn(`GROBID unavailable: ${err?.message} — using unpdf fallback`);
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check — returns true if GROBID is alive.
   */
  async isAlive(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${this.baseUrl}/api/isalive`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── TEI XML parsing ────────────────────────────────────────────────────────

  /**
   * Parses GROBID TEI XML header output into a flat GrobidHeaderResult.
   * Uses lightweight regex/string parsing — no XML library dependency.
   */
  private parseTeiHeader(teiXml: string): GrobidHeaderResult {
    const result: GrobidHeaderResult = {};

    // Title
    const titleMatch = teiXml.match(/<title[^>]*level="a"[^>]*>([^<]+)<\/title>/i)
      ?? teiXml.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
      result.title = this.cleanText(titleMatch[1]);
    }

    // Abstract
    const abstractMatch = teiXml.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i);
    if (abstractMatch?.[1]) {
      result.abstract = this.cleanText(abstractMatch[1].replace(/<[^>]+>/g, ' ')).slice(0, 3000);
    }

    // DOI
    const doiMatch = teiXml.match(/<idno[^>]*type="DOI"[^>]*>([^<]+)<\/idno>/i);
    if (doiMatch?.[1]) {
      result.doi = doiMatch[1].trim();
    }

    // ArXiv ID
    const arxivMatch = teiXml.match(/<idno[^>]*type="arXiv"[^>]*>([^<]+)<\/idno>/i);
    if (arxivMatch?.[1]) {
      result.arxivId = arxivMatch[1].replace(/^arxiv:/i, '').trim();
    }

    // Year (from date element)
    const dateMatch = teiXml.match(/<date[^>]*when="(\d{4})/i);
    if (dateMatch?.[1]) {
      result.year = parseInt(dateMatch[1], 10);
    }

    // Journal
    const journalMatch = teiXml.match(/<title[^>]*level="j"[^>]*>([^<]+)<\/title>/i);
    if (journalMatch?.[1]) {
      result.journal = this.cleanText(journalMatch[1]);
    }

    // Authors
    const authors: string[] = [];
    const persNameRegex = /<persName>([\s\S]*?)<\/persName>/gi;
    let persMatch: RegExpExecArray | null;
    while ((persMatch = persNameRegex.exec(teiXml)) !== null) {
      const block = persMatch[1];
      const forename = block.match(/<forename[^>]*>([^<]+)<\/forename>/i)?.[1]?.trim() ?? '';
      const surname = block.match(/<surname[^>]*>([^<]+)<\/surname>/i)?.[1]?.trim() ?? '';
      const fullName = [forename, surname].filter(Boolean).join(' ');
      if (fullName && fullName.length > 1) {
        authors.push(fullName);
      }
    }
    if (authors.length > 0) result.authors = authors;

    // Keywords
    const keywords: string[] = [];
    const kwRegex = /<term>([^<]+)<\/term>/gi;
    let kwMatch: RegExpExecArray | null;
    while ((kwMatch = kwRegex.exec(teiXml)) !== null) {
      const kw = this.cleanText(kwMatch[1]);
      if (kw) keywords.push(kw);
    }
    if (keywords.length > 0) result.keywords = keywords;

    return result;
  }

  private cleanText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }
}
