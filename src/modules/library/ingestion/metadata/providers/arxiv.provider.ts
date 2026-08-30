import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '../types/metadata.types';
import { normalizeArxivId, normalizeDoi } from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class ArxivProvider implements MetadataProvider {
  readonly id: ProviderName = 'arXiv';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ARXIV'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(ArxivProvider.name);
  private readonly BASE_URL = 'https://export.arxiv.org/api/query';

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanId = normalizeArxivId(request.query) ?? request.query.trim();
    if (!cleanId) return null;

    const url = `${this.BASE_URL}?id_list=${encodeURIComponent(cleanId)}&max_results=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        Accept: 'application/atom+xml, application/xml, text/xml',
      },
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `arXiv API HTTP ${response.status} for id: ${cleanId}`,
        response.status,
        retryAfterMs,
      );
    }

    let xmlText: string;
    try {
      xmlText = await response.text();
    } catch {
      throw new ProviderFetchError(
        `Failed to read arXiv XML response for id: ${cleanId}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    return this.parseAtomXml(xmlText, cleanId);
  }

  private parseAtomXml(xml: string, cleanId: string): ProviderResult | null {
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
    if (!entryMatch) return null;

    const entry = entryMatch[1];

    // Check if error/not found in entry
    if (entry.includes('<title>Error</title>')) return null;

    // Title
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/\s+/g, ' ').trim()
      : 'Untitled arXiv Paper';

    // Authors
    const authors: string[] = [];
    const authorMatches = entry.matchAll(
      /<author>\s*<name>([\s\S]*?)<\/name>/gi,
    );
    for (const match of authorMatches) {
      if (match[1]) {
        authors.push(match[1].trim());
      }
    }

    // Published date & year
    let year: number | null = null;
    let publicationDate: string | undefined;
    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/i);
    if (publishedMatch) {
      publicationDate = publishedMatch[1].trim();
      const yearMatch = publicationDate.match(/^(\d{4})/);
      if (yearMatch) year = Number(yearMatch[1]);
    }

    // Abstract / summary
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/i);
    const abstract = summaryMatch
      ? summaryMatch[1].replace(/\s+/g, ' ').trim()
      : undefined;

    // DOI (if exists in arxiv:doi)
    let doi: string | undefined;
    const doiMatch = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
    if (doiMatch) {
      doi = normalizeDoi(doiMatch[1]);
    }

    // Journal ref
    let journal: string | undefined;
    const journalMatch = entry.match(
      /<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/i,
    );
    if (journalMatch) {
      journal = journalMatch[1].replace(/\s+/g, ' ').trim();
    }

    // PDF link
    const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`;
    const canonicalUrl = `https://arxiv.org/abs/${cleanId}`;

    const rawVersion = createHash('md5').update(xml).digest('hex');

    return {
      provider: this.id,
      metadata: {
        arxivId: cleanId,
        doi,
        title,
        authors,
        year,
        publicationDate,
        journal,
        abstract,
        itemType: 'preprint',
        url: canonicalUrl,
        openAccessPdfUrl: pdfUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: `arxiv:${cleanId}`,
          canonicalUrl,
          confidenceScore: 0.95,
          rawSnapshotHash: rawVersion,
          isOpenAccess: true,
          openAccessPdfUrl: pdfUrl,
        },
      },
      confidence: 0.95,
      identifier: cleanId,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
