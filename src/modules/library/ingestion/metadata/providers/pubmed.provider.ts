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
  cleanBibliographicText,
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
  private readonly CTXP_BASE_URL =
    'https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pubmed/';
  private readonly EUTILS_BASE_URL =
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

  private get email(): string {
    return (
      process.env.NCBI_EMAIL ||
      process.env.ACADEMIC_EMAIL ||
      'contact@flux.academic'
    );
  }

  private get apiKey(): string | undefined {
    return process.env.NCBI_API_KEY;
  }

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanPmid = normalizePmid(request.query);
    const cleanPmcid = normalizePmcid(request.query);
    if (!cleanPmid && !cleanPmcid) return null;

    const isPmc = Boolean(cleanPmcid && !cleanPmid);
    const targetId = isPmc ? cleanPmcid! : cleanPmid!;

    // 1. Try modern NCBI Citation API (fast, clean JSON, unaffected by eutils IP blocker)
    try {
      const cslResult = await this.resolveViaCtxp(targetId, isPmc, signal);
      if (cslResult) return cslResult;
    } catch (err: any) {
      this.logger.debug(
        `NCBI ctxp resolution failed for ${targetId}: ${err?.message}. Falling back to E-utilities.`,
      );
    }

    // 2. Fallback to E-utilities with proper tool, email, and apiKey parameters (PMID only)
    if (!isPmc) {
      return this.resolveViaEutils(targetId, signal);
    }
    return null;
  }

  private async resolveViaCtxp(
    id: string,
    isPmc: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const endpoint = isPmc ? 'pmc' : 'pubmed';
    const numericId = isPmc ? id.replace(/^PMC/i, '') : id;
    let url = `https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/${endpoint}/?format=csl&id=${encodeURIComponent(numericId)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        Accept: '*/*',
      },
      signal,
    });

    if (response.status === 404) return null;
    if (!response.ok) return null;

    const contentType =
      (typeof response.headers?.get === 'function'
        ? response.headers.get('content-type')
        : (response.headers as any)?.['content-type']) || '';
    if (contentType.includes('text/html')) return null;

    let data: any;
    try {
      data = await response.json();
    } catch {
      return null;
    }

    if (!data || !data.title) return null;
    return this.transformCslPayload(data, id, isPmc);
  }

  private async resolveViaEutils(
    cleanPmid: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    let url = `${this.EUTILS_BASE_URL}?db=pubmed&id=${encodeURIComponent(cleanPmid)}&retmode=json&tool=FluxAcademic&email=${encodeURIComponent(this.email)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) return null;

    // Guard against NCBI misuse HTML block response
    const contentType =
      (typeof response.headers?.get === 'function'
        ? response.headers.get('content-type')
        : (response.headers as any)?.['content-type']) || '';
    if (contentType.includes('text/html')) {
      throw new ProviderFetchError(
        `NCBI E-utilities blocked or returned HTML diagnostic for PMID: ${cleanPmid}`,
        403,
        undefined,
        false,
        false,
      );
    }

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

  private transformCslPayload(
    data: Record<string, any>,
    id: string,
    isPmc: boolean = false,
  ): ProviderResult {
    const rawTitle =
      typeof data.title === 'string' ? data.title : 'Untitled PubMed Article';
    const title =
      cleanBibliographicText(rawTitle) || 'Untitled PubMed Article';

    const authors: string[] = [];
    const creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
    }> = [];

    if (Array.isArray(data.author)) {
      for (let i = 0; i < data.author.length; i++) {
        const a = data.author[i];
        if (a && typeof a === 'object') {
          const family = typeof a.family === 'string' ? a.family.trim() : '';
          const given = typeof a.given === 'string' ? a.given.trim() : '';
          const fullName =
            family && given
              ? `${family}, ${given}`
              : family || given || a.name || '';
          if (fullName) {
            authors.push(fullName);
            creators.push({
              orderIndex: i,
              creatorType: 'author',
              firstName: given || undefined,
              lastName: family || undefined,
              fullName,
            });
          }
        }
      }
    }

    let year: number | null = null;
    const dateParts =
      data.issued?.['date-parts']?.[0] ||
      data['epub-date']?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) {
      year = Number(dateParts[0]);
    }

    const doi =
      typeof data.DOI === 'string' ? normalizeDoi(data.DOI) : undefined;
    const resolvedPmcid =
      typeof data.PMCID === 'string'
        ? normalizePmcid(data.PMCID)
        : isPmc
          ? normalizePmcid(id)
          : undefined;
    const resolvedPmid =
      typeof data.PMID === 'string' || typeof data.PMID === 'number'
        ? String(data.PMID)
        : !isPmc
          ? id
          : undefined;

    const journal =
      typeof data['container-title'] === 'string'
        ? data['container-title']
        : undefined;
    const journalAbbr =
      typeof data['container-title-short'] === 'string'
        ? data['container-title-short']
        : undefined;
    const volume =
      typeof data.volume === 'string' || typeof data.volume === 'number'
        ? String(data.volume)
        : undefined;
    const issue =
      typeof data.issue === 'string' || typeof data.issue === 'number'
        ? String(data.issue)
        : undefined;
    const pages = typeof data.page === 'string' ? data.page : undefined;
    const issn = typeof data.ISSN === 'string' ? data.ISSN : undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(data))
      .digest('hex');

    const canonicalUrl = isPmc
      ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${resolvedPmcid || id}/`
      : `https://pubmed.ncbi.nlm.nih.gov/${resolvedPmid || id}/`;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        creators,
        year,
        pmid: resolvedPmid,
        pmcid: resolvedPmcid,
        doi,
        journal,
        journalAbbr,
        volume,
        issue,
        pages,
        issn,
        itemType: 'journalArticle',
        url: canonicalUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: isPmc
            ? `pmc:${resolvedPmcid || id}`
            : `pmid:${resolvedPmid || id}`,
          canonicalUrl,
          confidenceScore: 0.98,
          rawSnapshotHash: rawVersion,
          isOpenAccess: Boolean(resolvedPmcid),
        },
      },
      confidence: 0.98,
      identifier: resolvedPmid || resolvedPmcid || id,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
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
      typeof item.fulljournalname === 'string'
        ? item.fulljournalname
        : undefined;
    const sourceStr = typeof item.source === 'string' ? item.source : undefined;
    const volumeStr = typeof item.volume === 'string' ? item.volume : undefined;
    const issueStr = typeof item.issue === 'string' ? item.issue : undefined;
    const pagesStr = typeof item.pages === 'string' ? item.pages : undefined;
    const issnStr = typeof item.issn === 'string' ? item.issn : undefined;
    const creators = authors.map((name, idx) => ({
      orderIndex: idx,
      creatorType: 'author',
      fullName: name,
    }));

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        creators,
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
