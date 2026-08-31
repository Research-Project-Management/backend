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
import {
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
} from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class PubMedProvider implements MetadataProvider {
  readonly id: ProviderName = 'PubMed';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['PMID'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(PubMedProvider.name);
  private readonly BASE_URL =
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanPmid = normalizePmid(request.query);
    if (!cleanPmid) return null;

    const url = `${this.BASE_URL}?db=pubmed&id=${encodeURIComponent(cleanPmid)}&retmode=json`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        Accept: 'application/json',
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
        `PubMed API HTTP ${response.status} for PMID: ${cleanPmid}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse PubMed JSON for PMID: ${cleanPmid}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as {
      result?: Record<string, Record<string, unknown>>;
    } | null;
    const item = payload?.result?.[cleanPmid];
    if (!item || item.error) return null;

    return this.transformPayload(item, cleanPmid);
  }

  private transformPayload(
    item: Record<string, unknown>,
    cleanPmid: string,
  ): ProviderResult {
    const rawTitle =
      typeof item.title === 'string' ? item.title : 'Untitled PubMed Article';
    const title = rawTitle.replace(/\.$/, '').trim();

    const authors: string[] = [];
    if (Array.isArray(item.authors)) {
      for (const a of item.authors) {
        if (
          a &&
          typeof a === 'object' &&
          typeof (a as { name?: string }).name === 'string'
        ) {
          authors.push((a as { name: string }).name.trim());
        }
      }
    }

    let year: number | null = null;
    if (typeof item.pubdate === 'string') {
      const match = item.pubdate.match(/^(\d{4})/);
      if (match) year = Number(match[1]);
    }

    let doi: string | undefined;
    let pmcid: string | undefined;
    if (Array.isArray(item.articleids)) {
      for (const rawId of item.articleids) {
        if (rawId && typeof rawId === 'object') {
          const idObj = rawId as { idtype?: string; value?: string };
          if (idObj.idtype === 'doi' && typeof idObj.value === 'string') {
            doi = normalizeDoi(idObj.value);
          }
          if (
            (idObj.idtype === 'pmc' || idObj.idtype === 'pmcid') &&
            typeof idObj.value === 'string'
          ) {
            pmcid = normalizePmcid(idObj.value);
          }
        }
      }
    }

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const canonicalUrl = `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`;

    const fullJournalName =
      typeof item.fulljournalname === 'string' ? item.fulljournalname : undefined;
    const sourceStr =
      typeof item.source === 'string' ? item.source : undefined;
    const volumeStr =
      typeof item.volume === 'string' ? item.volume : undefined;
    const issueStr =
      typeof item.issue === 'string' ? item.issue : undefined;
    const pagesStr =
      typeof item.pages === 'string' ? item.pages : undefined;
    const issnStr =
      typeof item.issn === 'string' ? item.issn : undefined;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        year,
        pmid: cleanPmid,
        pmcid,
        doi,
        journal: fullJournalName || sourceStr || undefined,
        journalAbbr: sourceStr || undefined,
        volume: volumeStr || undefined,
        issue: issueStr || undefined,
        pages: pagesStr || undefined,
        issn: issnStr || undefined,
        itemType: 'journalArticle',
        url: canonicalUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: `pmid:${cleanPmid}`,
          canonicalUrl,
          confidenceScore: 0.97,
          rawSnapshotHash: rawVersion,
          isOpenAccess: Boolean(pmcid),
        },
      },
      confidence: 0.97,
      identifier: cleanPmid,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
