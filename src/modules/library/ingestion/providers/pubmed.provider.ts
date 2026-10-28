import { parseMedlineDate, enrichFromEuropePmc } from './pubmed.helper';
import { Injectable, Optional } from '@nestjs/common';
import {
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  cleanBibliographicText,
  cleanAbstractText,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
  normalizePageRange,
  parseCreatorString,
  normalizeAcademicTags,
} from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '@/modules/library/core/constants/academic-client.constants';
import { AbstractAcademicProvider } from './abstract-academic.provider';

@Injectable()
export class PubMedProvider extends AbstractAcademicProvider {
  readonly id: ProviderName = 'PubMed';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['PMID'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  constructor(
    @Optional() httpClient?: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get eutilsBaseUrl(): string {
    const base =
      this.configService?.providers.ncbiBaseUrl ??
      libraryConfig().providers.ncbiBaseUrl;
    return base.endsWith('.fcgi') ? base : `${base}/esummary.fcgi`;
  }

  private get email(): string {
    return (
      this.configService?.providers.ncbiEmail ??
      libraryConfig().providers.ncbiEmail ??
      getAcademicContactEmail()
    );
  }

  private get apiKey(): string | undefined {
    return (
      this.configService?.providers.ncbiApiKey ??
      libraryConfig().providers.ncbiApiKey
    );
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

    let result: ProviderResult | null = null;
    try {
      result = await this.resolveViaCtxp(targetId, isPmc, signal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `NCBI ctxp resolution failed for ${targetId}: ${msg}. Falling back to E-utilities.`,
      );
    }

    if (!result && !isPmc) {
      result = await this.resolveViaEutils(targetId, signal);
    }

    if (result) {
      const effectivePmid = result.metadata.pmid || (!isPmc ? targetId : undefined);
      if (effectivePmid) {
        await this.enrichFromPubmedXml(result, effectivePmid, signal);
      }
    }
    return result;
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

    const headers = {
      'User-Agent': getAcademicUserAgent('PubMed'),
      Accept: '*/*',
    };

    const response = await this.executeHttpFetch(url, signal, headers);

    if (response.status === 404) return null;
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) return null;

    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
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
    let url = `${this.eutilsBaseUrl}?db=pubmed&id=${encodeURIComponent(cleanPmid)}&retmode=json&tool=FluxAcademic&email=${encodeURIComponent(this.email)}`;
    if (this.apiKey) {
      url += `&api_key=${encodeURIComponent(this.apiKey)}`;
    }

    const headers = {
      'User-Agent': getAcademicUserAgent('PubMed'),
      Accept: 'application/json',
    };

    const response = await this.executeHttpFetch(url, signal, headers);

    if (response.status === 404) return null;

    const contentType = response.headers.get('content-type') || '';
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
      const retryAfterMs = this.parseRetryAfterHeader(response);
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
    data: Record<string, unknown>,
    id: string,
    isPmc: boolean = false,
  ): ProviderResult {
    const rawTitle =
      typeof data.title === 'string' ? data.title : 'Untitled PubMed Article';
    const title = cleanBibliographicText(rawTitle) || 'Untitled PubMed Article';

    const authors: string[] = [];
    const creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
      fieldMode?: number;
    }> = [];

    if (Array.isArray(data.author)) {
      for (let i = 0; i < data.author.length; i++) {
        const a = data.author[i] as
          | { family?: string; given?: string; literal?: string; name?: string }
          | undefined;
        if (a && typeof a === 'object') {
          const family = typeof a.family === 'string' ? a.family.trim() : '';
          const given = typeof a.given === 'string' ? a.given.trim() : '';
          const literal =
            typeof a.literal === 'string'
              ? a.literal.trim()
              : typeof a.name === 'string'
                ? a.name.trim()
                : '';
          if (!family && !given && literal) {
            authors.push(literal);
            creators.push({
              orderIndex: i,
              creatorType: 'author',
              lastName: literal,
              fullName: literal,
              fieldMode: 1,
            });
            continue;
          }
          const fullName =
            family && given ? `${given} ${family}` : family || given || '';
          if (fullName) {
            authors.push(fullName);
            creators.push({
              orderIndex: i,
              creatorType: 'author',
              firstName: family ? given || undefined : undefined,
              lastName: family || given || undefined,
              fullName,
              fieldMode: family ? 0 : 1,
            });
          }
        }
      }
    }

    let year: number | null = null;
    let publicationDate: string | undefined;
    const dateParts = [
      (
        data.issued as
          { 'date-parts'?: Array<Array<string | number>> } | undefined
      )?.['date-parts']?.[0],
      (
        data['epub-date'] as
          { 'date-parts'?: Array<Array<string | number>> } | undefined
      )?.['date-parts']?.[0],
    ].find((parts) => Array.isArray(parts) && Boolean(parts[0]));
    if (dateParts && dateParts[0] != null) {
      year = Number(dateParts[0]);
      const y = String(dateParts[0]).padStart(4, '0');
      publicationDate =
        dateParts[1] != null
          ? dateParts[2] != null
            ? `${y}-${String(dateParts[1]).padStart(2, '0')}-${String(dateParts[2]).padStart(2, '0')}`
            : `${y}-${String(dateParts[1]).padStart(2, '0')}`
          : y;
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
    const shortTitle =
      typeof data['title-short'] === 'string' && data['title-short'].trim()
        ? data['title-short'].trim()
        : typeof data.shortTitle === 'string' && data.shortTitle.trim()
          ? data.shortTitle.trim()
          : undefined;
    const language =
      typeof data.language === 'string' && data.language.trim()
        ? data.language.trim()
        : undefined;
    const publisher =
      typeof data.publisher === 'string' && data.publisher.trim()
        ? data.publisher.trim()
        : undefined;
    const place =
      typeof data['publisher-place'] === 'string' &&
      data['publisher-place'].trim()
        ? data['publisher-place'].trim()
        : undefined;
    const volume =
      typeof data.volume === 'string' || typeof data.volume === 'number'
        ? String(data.volume)
        : undefined;
    const issue =
      typeof data.issue === 'string' || typeof data.issue === 'number'
        ? String(data.issue)
        : undefined;
    const pages =
      typeof data.page === 'string' ? normalizePageRange(data.page) : undefined;
    const issn = typeof data.ISSN === 'string' ? data.ISSN : undefined;

    const rawAbstract =
      typeof data.abstract === 'string'
        ? data.abstract
        : typeof data.Abstract === 'string'
          ? data.Abstract
          : undefined;
    const abstract = cleanAbstractText(rawAbstract);

    const openAccessPdfUrl = resolvedPmcid
      ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${resolvedPmcid}/pdf/`
      : undefined;

    const canonicalUrl = isPmc
      ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${resolvedPmcid || id}/`
      : `https://pubmed.ncbi.nlm.nih.gov/${resolvedPmid || id}/`;

    return this.buildProviderResult({
      identifier: resolvedPmid || resolvedPmcid || id,
      rawPayload: data,
      confidenceScore: 0.98,
      canonicalId: isPmc
        ? `pmc:${resolvedPmcid || id}`
        : `pmid:${resolvedPmid || id}`,
      sourceUrl: canonicalUrl,
      isOpenAccess: Boolean(resolvedPmcid),
      openAccessPdfUrl,
      metadata: {
        title,
        shortTitle,
        authors,
        creators,
        year,
        publicationDate,
        date: publicationDate,
        pmid: resolvedPmid,
        pmcid: resolvedPmcid,
        doi,
        journal,
        publicationTitle: journal,
        journalAbbr,
        publisher,
        place,
        language,
        volume,
        issue,
        pages,
        issn,
        abstract,
        openAccessPdfUrl,
        itemType: 'journalArticle',
        url: canonicalUrl,
        libraryCatalog: 'PubMed',
      },
    });
  }

  private transformPayload(
    item: Record<string, unknown>,
    cleanPmid: string,
  ): ProviderResult {
    const rawTitle =
      typeof item.title === 'string' ? item.title : 'Untitled PubMed Article';
    const title = (cleanBibliographicText(rawTitle) || rawTitle)
      .replace(/\.$/, '')
      .trim();

    const authors: string[] = [];
    const creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
      fieldMode?: number;
    }> = [];
    if (Array.isArray(item.authors)) {
      for (const a of item.authors) {
        if (
          a &&
          typeof a === 'object' &&
          typeof (a as { name?: string }).name === 'string'
        ) {
          const rawName = (a as { name: string }).name.trim();
          if (!rawName) continue;
          const authType = String(
            (a as { authtype?: string }).authtype || '',
          ).toLowerCase();
          if (authType === 'collectivename') {
            authors.push(rawName);
            creators.push({
              orderIndex: creators.length,
              creatorType: 'author',
              lastName: rawName,
              fullName: rawName,
              fieldMode: 1,
            });
            continue;
          }
          const parsed = parseCreatorString(rawName, creators.length, 'author');
          const fullName = parsed.fullName || rawName;
          authors.push(fullName);
          creators.push({
            orderIndex: creators.length,
            creatorType: 'author',
            firstName: parsed.firstName || undefined,
            lastName: parsed.lastName || rawName,
            fullName,
            fieldMode: parsed.fieldMode ?? 0,
          });
        }
      }
    }

    let year: number | null = null;
    let publicationDate: string | undefined;
    const rawPubDate =
      typeof item.pubdate === 'string'
        ? item.pubdate
        : typeof item.epubdate === 'string'
          ? item.epubdate
          : undefined;
    if (rawPubDate) {
      const match = rawPubDate.match(/^(\d{4})/);
      if (match) year = Number(match[1]);
      publicationDate = parseMedlineDate(rawPubDate);
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

    const canonicalUrl = `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`;

    const fullJournalName =
      typeof item.fulljournalname === 'string'
        ? item.fulljournalname
        : undefined;
    const sourceStr = typeof item.source === 'string' ? item.source : undefined;
    const volumeStr = typeof item.volume === 'string' ? item.volume : undefined;
    const issueStr = typeof item.issue === 'string' ? item.issue : undefined;
    const pagesStr =
      typeof item.pages === 'string'
        ? normalizePageRange(item.pages)
        : undefined;
    const issnStr = typeof item.issn === 'string' ? item.issn : undefined;

    const rawAbstract =
      typeof item.abstract === 'string'
        ? item.abstract
        : typeof item.abstractText === 'string'
          ? item.abstractText
          : undefined;
    const abstract = cleanAbstractText(rawAbstract);

    const openAccessPdfUrl = pmcid
      ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`
      : undefined;

    return this.buildProviderResult({
      identifier: cleanPmid,
      rawPayload: item,
      confidenceScore: 0.97,
      canonicalId: `pmid:${cleanPmid}`,
      sourceUrl: canonicalUrl,
      isOpenAccess: Boolean(pmcid),
      openAccessPdfUrl,
      metadata: {
        title,
        authors,
        creators,
        year,
        publicationDate,
        date: publicationDate,
        pmid: cleanPmid,
        pmcid,
        doi,
        journal: fullJournalName || sourceStr || undefined,
        journalAbbr: sourceStr || undefined,
        volume: volumeStr || undefined,
        issue: issueStr || undefined,
        pages: pagesStr || undefined,
        issn: issnStr || undefined,
        abstract,
        openAccessPdfUrl,
        itemType: 'journalArticle',
        url: canonicalUrl,
        libraryCatalog: 'PubMed',
      },
    });
  }

  private async enrichFromPubmedXml(
    result: ProviderResult,
    cleanPmid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const rawBase = this.eutilsBaseUrl.replace(/\/[^/]+\.fcgi$/i, '');
      const base = rawBase.startsWith('https://')
        ? rawBase
        : 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
      let url = `${base}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(cleanPmid)}&retmode=xml&tool=FluxAcademic&email=${encodeURIComponent(this.email)}`;
      if (this.apiKey) {
        url += `&api_key=${encodeURIComponent(this.apiKey)}`;
      }
      const headers = {
        'User-Agent': getAcademicUserAgent('PubMed'),
        Accept: 'application/xml, text/xml, */*',
      };
      const response = await this.executeHttpFetch(url, signal, headers);
      let xml = '';
      if (response.ok) {
        xml = await response.text();
      }
      const rawTags: string[] = [];

      if (xml && xml.includes('<PubmedArticle')) {
        // 1. Extract MeSH headings (<MeshHeading> -> <DescriptorName> + <QualifierName>)
        const meshBlocks =
          xml.match(/<MeshHeading>[\s\S]*?<\/MeshHeading>/gi) || [];
        for (const block of meshBlocks) {
          const descMatch = block.match(
            /<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/i,
          );
          if (!descMatch || !descMatch[1]) continue;
          const descriptor = this.cleanXmlText(descMatch[1]);
          if (!descriptor) continue;
          const qualMatches = Array.from(
            block.matchAll(/<QualifierName[^>]*>([\s\S]*?)<\/QualifierName>/gi),
          );
          if (qualMatches.length > 0) {
            for (const qm of qualMatches) {
              const qual = this.cleanXmlText(qm[1]);
              if (qual) rawTags.push(`${descriptor}/${qual}`);
            }
          } else {
            rawTags.push(descriptor);
          }
        }

        // 2. Extract Author Keywords (<Keyword>)
        const kwMatches = Array.from(
          xml.matchAll(/<Keyword(?:\s+[^>]*)?>([\s\S]*?)<\/Keyword>/gi),
        );
        for (const km of kwMatches) {
          const kw = this.cleanXmlText(km[1]);
          if (kw) rawTags.push(kw);
        }

        // 3. Extract full Abstract if missing from ctxp/esummary
        if (!result.metadata.abstract) {
          const absParts: string[] = [];
          const absMatches = Array.from(
            xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/gi),
          );
          for (const am of absMatches) {
            const attrs = am[1] || '';
            const labelMatch = attrs.match(/Label="([^"]+)"/i);
            const textPart = cleanAbstractText(am[2]);
            if (textPart) {
              absParts.push(
                labelMatch?.[1] ? `${labelMatch[1]}: ${textPart}` : textPart,
              );
            }
          }
          if (absParts.length > 0) {
            result.metadata.abstract = absParts.join('\n\n');
          }
        }
      } else {
        // Fallback to EuropePMC REST API when NCBI efetch.fcgi returns HTML error/rate-limit diagnostic
        await enrichFromEuropePmc(result, cleanPmid, rawTags, this.httpClient, signal);
      }

      if (rawTags.length > 0) {
        const normalizedTags = normalizeAcademicTags(rawTags);
        if (normalizedTags.length > 0) {
          result.metadata.keywords = normalizedTags;
          result.metadata.tags = normalizedTags;
        }
      }
    } catch (err: unknown) {
      this.logger.debug(
        `Optional PubMed XML enrichment skipped for ${cleanPmid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private cleanXmlText(raw?: string): string | undefined {
    if (!raw) return undefined;
    const stripped = raw.replace(/<\/?[a-zA-Z0-9:_-]+(?:\s+[^>]*)?>/g, '');
    return cleanBibliographicText(stripped);
  }
}
