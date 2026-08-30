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

    let json: any;
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

    const item = json?.result?.[cleanPmid];
    if (!item || item.error) return null;

    return this.transformPayload(item, cleanPmid);
  }

  private transformPayload(item: any, cleanPmid: string): ProviderResult {
    const title = (item.title || 'Untitled PubMed Article')
      .replace(/\.$/, '')
      .trim();

    const authors: string[] = Array.isArray(item.authors)
      ? item.authors.map((a: any) => a.name).filter(Boolean)
      : [];

    let year: number | null = null;
    if (item.pubdate) {
      const match = item.pubdate.match(/^(\d{4})/);
      if (match) year = Number(match[1]);
    }

    let doi: string | undefined;
    let pmcid: string | undefined;
    if (Array.isArray(item.articleids)) {
      const doiObj = item.articleids.find((id: any) => id.idtype === 'doi');
      if (doiObj?.value) doi = normalizeDoi(doiObj.value);
      const pmcObj = item.articleids.find(
        (id: any) => id.idtype === 'pmc' || id.idtype === 'pmcid',
      );
      if (pmcObj?.value) pmcid = normalizePmcid(pmcObj.value);
    }

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const canonicalUrl = `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        year,
        pmid: cleanPmid,
        pmcid,
        doi,
        journal: item.fulljournalname || item.source || undefined,
        journalAbbr: item.source || undefined,
        volume: item.volume || undefined,
        issue: item.issue || undefined,
        pages: item.pages || undefined,
        issn: item.issn || undefined,
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
