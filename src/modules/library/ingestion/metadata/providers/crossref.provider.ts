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
  normalizeIsbn,
  normalizeIssn,
  cleanBibliographicText,
} from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class CrossRefProvider implements MetadataProvider {
  readonly id: ProviderName = 'CrossRef';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(CrossRefProvider.name);

  private get mailto(): string {
    return (
      process.env.CROSSREF_EMAIL ||
      process.env.ACADEMIC_EMAIL ||
      'contact@flux.academic'
    );
  }

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const { query } = request;
    const cleanDoi = normalizeDoi(query);

    if (cleanDoi) {
      return this.resolveByDoi(cleanDoi, signal);
    }
    return this.searchByTitle(query, signal);
  }

  private async resolveByDoi(
    doi: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(this.mailto)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `CrossRef API HTTP ${response.status} for DOI: ${doi}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse CrossRef JSON for DOI: ${doi}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as { message?: Record<string, unknown> } | null;
    if (!payload?.message) return null;
    return this.transformMessage(payload.message, doi, true);
  }

  private async searchByTitle(
    title: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanTitle)}&rows=1&mailto=contact@flux.academic`;

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
        `CrossRef search HTTP ${response.status} for title: ${cleanTitle}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse CrossRef search JSON for title: ${cleanTitle}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as {
      message?: { items?: Array<Record<string, unknown>> };
    } | null;
    const item = payload?.message?.items?.[0];
    if (!item) return null;

    const rawDoi = typeof item.DOI === 'string' ? item.DOI : '';
    const doi = normalizeDoi(rawDoi) || rawDoi;
    return this.transformMessage(item, doi, false);
  }

  private transformMessage(
    message: Record<string, unknown>,
    doi: string,
    isDirectDoi: boolean,
  ): ProviderResult {
    const rawTitle = message.title;
    const rawTitleStr = Array.isArray(rawTitle)
      ? typeof rawTitle[0] === 'string'
        ? rawTitle[0]
        : 'Untitled'
      : typeof rawTitle === 'string'
        ? rawTitle
        : 'Untitled';
    const title = cleanBibliographicText(rawTitleStr) || 'Untitled';

    const authors: string[] = [];
    const creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
    }> = [];

    const addCreators = (list: unknown, role: string) => {
      if (Array.isArray(list)) {
        for (const rawAuth of list) {
          if (rawAuth && typeof rawAuth === 'object') {
            const auth = rawAuth as {
              given?: string;
              family?: string;
              name?: string;
            };
            const firstName = auth.given?.trim();
            const lastName = auth.family?.trim();
            let fullName = '';
            if (firstName && lastName) {
              fullName = `${lastName}, ${firstName}`;
            } else if (lastName) {
              fullName = lastName;
            } else if (firstName) {
              fullName = firstName;
            } else if (auth.name) {
              fullName = auth.name.trim();
            }

            if (fullName) {
              if (role === 'author') {
                authors.push(fullName);
              }
              creators.push({
                orderIndex: creators.length,
                creatorType: role,
                firstName: firstName || undefined,
                lastName: lastName || undefined,
                fullName,
              });
            }
          }
        }
      }
    };

    addCreators(message.author, 'author');
    addCreators(message.editor, 'editor');
    addCreators(message.translator, 'translator');
    addCreators(message.chair, 'presenter');

    let year: number | null = null;
    const pubPrint = message['published-print'] as
      { 'date-parts'?: number[][] } | undefined;
    const pubOnline = message['published-online'] as
      { 'date-parts'?: number[][] } | undefined;
    const issued = message.issued as { 'date-parts'?: number[][] } | undefined;

    const dateParts =
      pubPrint?.['date-parts']?.[0] ||
      pubOnline?.['date-parts']?.[0] ||
      issued?.['date-parts']?.[0];
    if (dateParts && dateParts[0]) {
      year = Number(dateParts[0]);
    }

    const containerTitle = message['container-title'];
    const rawJournal = Array.isArray(containerTitle)
      ? typeof containerTitle[0] === 'string'
        ? containerTitle[0]
        : undefined
      : typeof containerTitle === 'string'
        ? containerTitle
        : undefined;
    const journal = cleanBibliographicText(rawJournal);

    const typeStr = typeof message.type === 'string' ? message.type : '';
    let itemType = 'journalArticle';
    if (typeStr === 'journal-article') {
      itemType = 'journalArticle';
    } else if (typeStr === 'book-chapter' || typeStr === 'book-section') {
      itemType = 'bookSection';
    } else if (
      typeStr === 'proceedings-article' ||
      typeStr === 'conference-paper' ||
      typeStr === 'proceedings'
    ) {
      itemType = 'conferencePaper';
    } else if (
      typeStr === 'book' ||
      typeStr === 'monograph' ||
      typeStr === 'edited-book' ||
      typeStr === 'reference-book'
    ) {
      itemType = 'book';
    } else if (typeStr === 'dissertation') {
      itemType = 'thesis';
    } else if (typeStr === 'report' || typeStr === 'report-series') {
      itemType = 'report';
    } else if (typeStr === 'posted-content' || typeStr === 'preprint') {
      itemType = 'preprint';
    } else if (typeStr === 'dataset') {
      itemType = 'dataset';
    } else if (typeStr === 'standard' || typeStr === 'component') {
      itemType = 'standard';
    }

    const keywords: string[] = [];
    if (Array.isArray(message.subject)) {
      for (const subj of message.subject) {
        if (typeof subj === 'string' && subj.trim()) {
          keywords.push(subj.trim());
        }
      }
    }

    const shortContainer = message['short-container-title'];
    const rawJournalAbbr = Array.isArray(shortContainer)
      ? typeof shortContainer[0] === 'string'
        ? shortContainer[0]
        : undefined
      : typeof shortContainer === 'string'
        ? shortContainer
        : undefined;
    const journalAbbr = cleanBibliographicText(rawJournalAbbr);

    const collectionTitle = message['collection-title'];
    const rawSeries = Array.isArray(collectionTitle)
      ? typeof collectionTitle[0] === 'string'
        ? collectionTitle[0]
        : undefined
      : typeof collectionTitle === 'string'
        ? collectionTitle
        : undefined;
    const series = cleanBibliographicText(rawSeries);

    const rawVersion = createHash('md5')
      .update(JSON.stringify(message))
      .digest('hex');

    const publisher = cleanBibliographicText(
      typeof message.publisher === 'string' ? message.publisher : undefined,
    );
    const volume =
      typeof message.volume === 'string' ? message.volume : undefined;
    const issue = typeof message.issue === 'string' ? message.issue : undefined;
    const pages = typeof message.page === 'string' ? message.page : undefined;

    const rawIssn = message.ISSN;
    const rawIssnStr = Array.isArray(rawIssn)
      ? typeof rawIssn[0] === 'string'
        ? rawIssn[0]
        : undefined
      : typeof rawIssn === 'string'
        ? rawIssn
        : undefined;
    const issn = normalizeIssn(rawIssnStr) || rawIssnStr;

    const rawIsbn = message.ISBN;
    const rawIsbnStr = Array.isArray(rawIsbn)
      ? typeof rawIsbn[0] === 'string'
        ? rawIsbn[0]
        : undefined
      : typeof rawIsbn === 'string'
        ? rawIsbn
        : undefined;
    const isbn = normalizeIsbn(rawIsbnStr) || rawIsbnStr;

    const rawUrl =
      typeof message.URL === 'string'
        ? message.URL
        : doi
          ? `https://doi.org/${doi}`
          : undefined;

    const abstract = cleanBibliographicText(
      typeof message.abstract === 'string' ? message.abstract : undefined,
    );

    const links = Array.isArray(message.link) ? message.link : [];
    const isOpenAccess = links.some(
      (l) =>
        l &&
        typeof l === 'object' &&
        (l as Record<string, unknown>)['content-type'] === 'application/pdf',
    );
    const language =
      typeof message.language === 'string' && message.language.trim()
        ? message.language.trim()
        : undefined;

    let license: string | undefined;
    if (Array.isArray(message.license) && message.license.length > 0) {
      const firstLicense = message.license[0] as { URL?: string };
      if (firstLicense && typeof firstLicense.URL === 'string') {
        license = firstLicense.URL.trim();
      }
    }

    let archive: string | undefined;
    if (Array.isArray(message.archive) && message.archive.length > 0) {
      archive = String(message.archive[0]).trim();
    } else if (typeof message.archive === 'string' && message.archive.trim()) {
      archive = message.archive.trim();
    }

    const shortTitleRaw = message['short-title'];
    const rawShortTitle = Array.isArray(shortTitleRaw)
      ? typeof shortTitleRaw[0] === 'string'
        ? shortTitleRaw[0].trim()
        : undefined
      : typeof shortTitleRaw === 'string'
        ? shortTitleRaw.trim()
        : undefined;
    const shortTitle = cleanBibliographicText(rawShortTitle);

    return {
      provider: this.id,
      metadata: {
        doi: doi || undefined,
        title,
        shortTitle,
        authors,
        creators,
        year,
        journal,
        journalAbbr,
        publisher,
        volume,
        issue,
        pages,
        series,
        issn,
        isbn,
        url: rawUrl,
        abstract,
        language,
        license,
        rights: license,
        archive,
        keywords: keywords.length ? keywords : undefined,
        itemType,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: doi ? `doi:${doi}` : `crossref:${title}`,
          canonicalUrl: rawUrl,
          confidenceScore: isDirectDoi ? 0.99 : 0.85,
          rawSnapshotHash: rawVersion,
          isOpenAccess,
        },
      },
      confidence: isDirectDoi ? 0.99 : 0.85,
      identifier: doi || title,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
