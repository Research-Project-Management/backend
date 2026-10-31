import { Injectable, Optional } from '@nestjs/common';
import {
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeDoi,
  normalizeIsbn,
  normalizeIssn,
  cleanBibliographicText,
  cleanAbstractText,
  TITLE_MATCH_THRESHOLD,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
  CSL_TYPE_TO_ITEM_TYPE,
  normalizePageRange,
} from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import { getAcademicContactEmail } from '@/modules/library/core/constants/academic-client.constants';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { AbstractAcademicProvider } from './abstract-academic.provider';

@Injectable()
export class CrossRefProvider extends AbstractAcademicProvider {
  readonly id: ProviderName = 'CrossRef';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE'],
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

  private get mailto(): string {
    return (
      this.configService?.providers.crossrefEmail ??
      libraryConfig().providers.crossrefEmail ??
      getAcademicContactEmail()
    );
  }

  private async executeFetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers = {
      'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
      Accept: 'application/json',
    };
    return this.executeHttpFetch(url, signal, headers);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const { query } = request;
    if (
      /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.48550\/arxiv\./i.test(
        query.trim(),
      )
    ) {
      return null;
    }
    const cleanDoi = normalizeDoi(query);

    if (cleanDoi) {
      return this.resolveByDoi(cleanDoi, signal);
    }
    if (request.queryType && request.queryType !== 'TITLE') {
      return null;
    }
    return this.searchByTitle(query, signal);
  }

  async searchRecentWorks(
    params: { filter?: string; query?: string; rows?: number },
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = params.rows ?? 30;
    const baseQuery = params.filter
      ? `filter=${params.filter}&rows=${rows}&sort=published&order=desc`
      : `query=${encodeURIComponent(params.query ?? '')}&rows=${rows}&sort=published&order=desc`;
    const url = `https://api.crossref.org/works?${baseQuery}&mailto=${encodeURIComponent(this.mailto)}`;

    const response = await this.executeFetch(url, signal);
    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `Academic registry search responded with HTTP ${response.status}`,
        response.status,
        retryAfterMs,
      );
    }

    const json = (await response.json()) as {
      message?: { items?: Array<Record<string, unknown>> };
    } | null;
    return Array.isArray(json?.message?.items) ? json.message.items : [];
  }

  private async resolveByDoi(
    doi: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(this.mailto)}`;

    const response = await this.executeFetch(url, signal);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
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

    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanTitle)}&rows=5&mailto=${encodeURIComponent(this.mailto)}`;

    const response = await this.executeFetch(url, signal);

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
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
    const items = payload?.message?.items || [];

    const { bestMatch: best, bestScore } = this.rankBestTitleCandidate(
      items,
      cleanTitle,
      (candidate) =>
        Array.isArray(candidate.title)
          ? String(candidate.title[0] ?? '')
          : typeof candidate.title === 'string'
            ? candidate.title
            : '',
      TITLE_MATCH_THRESHOLD,
    );
    if (!best) {
      this.logger.debug(
        `CrossRef title search rejected for "${cleanTitle}" (best similarity ${bestScore.toFixed(2)})`,
      );
      return null;
    }

    const rawDoi = typeof best.DOI === 'string' ? best.DOI : '';
    const doi = normalizeDoi(rawDoi) || rawDoi;
    return this.transformMessage(best, doi, false);
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
    const baseTitle =
      rawTitleStr && rawTitleStr !== 'Untitled'
        ? cleanBibliographicText(rawTitleStr) || ''
        : '';

    const rawSubtitle = Array.isArray(message.subtitle)
      ? typeof message.subtitle[0] === 'string'
        ? message.subtitle[0]
        : undefined
      : typeof message.subtitle === 'string'
        ? message.subtitle
        : undefined;
    const subtitle = cleanBibliographicText(rawSubtitle);
    const title =
      subtitle &&
      baseTitle !== 'Untitled' &&
      !baseTitle.toLowerCase().includes(subtitle.toLowerCase())
        ? `${baseTitle.replace(/[\s:]+$/, '')}: ${subtitle}`
        : baseTitle || undefined;

    const authors: string[] = [];
    const creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
      fieldMode?: number;
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
            const orgName = auth.name?.trim();

            if (!firstName && !lastName && orgName) {
              if (role === 'author') authors.push(orgName);
              creators.push({
                orderIndex: creators.length,
                creatorType: role,
                lastName: orgName,
                fullName: orgName,
                fieldMode: 1,
              });
              continue;
            }

            let fullName = '';
            if (firstName && lastName) {
              fullName = `${firstName} ${lastName}`;
            } else if (lastName) {
              fullName = lastName;
            } else if (firstName) {
              fullName = firstName;
            }

            if (fullName) {
              if (role === 'author') {
                authors.push(fullName);
              }
              creators.push({
                orderIndex: creators.length,
                creatorType: role,
                firstName: lastName ? firstName || undefined : undefined,
                lastName: lastName || firstName || undefined,
                fullName,
                fieldMode: lastName ? 0 : 1,
              });
            }
          }
        }
      }
    };

    addCreators(message.author, 'author');
    addCreators(message.editor, 'editor');
    addCreators(message.translator, 'translator');
    addCreators(message.chair, 'contributor');

    let year: number | null = null;
    let publicationDate: string | undefined = undefined;
    const pubPrint = message['published-print'] as
      { 'date-parts'?: number[][] } | undefined;
    const pubOnline = message['published-online'] as
      { 'date-parts'?: number[][] } | undefined;
    const issued = message.issued as { 'date-parts'?: number[][] } | undefined;

    const candidateDateParts = [pubPrint, pubOnline, issued]
      .map((d) => d?.['date-parts']?.[0])
      .filter((parts): parts is number[] => Array.isArray(parts) && !!parts[0]);
    const dateParts = candidateDateParts.reduce<number[] | undefined>(
      (best, curr) => {
        if (!best) return curr;
        const bestLen = best.filter((p) => p != null).length;
        const currLen = curr.filter((p) => p != null).length;
        return currLen > bestLen ? curr : best;
      },
      undefined,
    );
    if (dateParts && dateParts[0]) {
      year = Number(dateParts[0]);
      const y = String(dateParts[0]).padStart(4, '0');
      if (dateParts[1]) {
        const m = String(dateParts[1]).padStart(2, '0');
        if (dateParts[2]) {
          const d = String(dateParts[2]).padStart(2, '0');
          publicationDate = `${y}-${m}-${d}`;
        } else {
          publicationDate = `${y}-${m}`;
        }
      } else {
        publicationDate = y;
      }
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
    const CROSSREF_TYPE_MAP: Record<string, string> = {
      'journal-article': 'journalArticle',
      'book-chapter': 'bookSection',
      'book-section': 'bookSection',
      'book-part': 'bookSection',
      'proceedings-article': 'conferencePaper',
      'conference-paper': 'conferencePaper',
      proceedings: 'book',
      book: 'book',
      monograph: 'book',
      'edited-book': 'book',
      'reference-book': 'book',
      'book-set': 'book',
      'book-series': 'book',
      'book-track': 'book',
      dissertation: 'thesis',
      report: 'report',
      'report-series': 'report',
      'report-component': 'report',
      'posted-content': 'preprint',
      preprint: 'preprint',
      dataset: 'dataset',
      database: 'dataset',
      standard: 'standard',
      'reference-entry': 'encyclopediaArticle',
      component: 'document',
      'peer-review': 'document',
      other: 'document',
    };
    const itemType = typeStr
      ? CROSSREF_TYPE_MAP[typeStr] ||
        (CSL_TYPE_TO_ITEM_TYPE[typeStr] ?? 'document')
      : 'journalArticle';

    const rawKeywords: string[] = [];
    if (Array.isArray(message.subject)) {
      for (const subj of message.subject) {
        if (typeof subj === 'string' && subj.trim()) {
          rawKeywords.push(subj.trim());
        }
      }
    }
    const keywords = normalizeAcademicTags(rawKeywords);

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

    const eventObj =
      typeof message.event === 'object' && message.event !== null
        ? (message.event as Record<string, unknown>)
        : undefined;
    const rawConferenceName =
      typeof eventObj?.name === 'string' ? eventObj.name : undefined;
    const conferenceName = cleanBibliographicText(rawConferenceName);

    const rawEventPlace =
      typeof eventObj?.location === 'string' ? eventObj.location : undefined;
    const eventPlace = cleanBibliographicText(rawEventPlace);
    const publisherLocation = cleanBibliographicText(
      typeof message['publisher-location'] === 'string'
        ? message['publisher-location']
        : undefined,
    );
    const place = publisherLocation || eventPlace;

    const rawProceedings = message['proceedings-title'];
    const rawProceedingsStr = Array.isArray(rawProceedings)
      ? typeof rawProceedings[0] === 'string'
        ? rawProceedings[0]
        : undefined
      : typeof rawProceedings === 'string'
        ? rawProceedings
        : undefined;
    const proceedingsTitle = cleanBibliographicText(rawProceedingsStr);

    // Extract institution object/array (used by CrossRef for dissertation, report, posted-content, dataset)
    let institutionName: string | undefined;
    let institutionPlace: string | undefined;
    const rawInst = message.institution;
    const instObj = Array.isArray(rawInst)
      ? rawInst[0] && typeof rawInst[0] === 'object'
        ? (rawInst[0] as Record<string, unknown>)
        : undefined
      : rawInst && typeof rawInst === 'object'
        ? (rawInst as Record<string, unknown>)
        : undefined;
    if (instObj) {
      if (typeof instObj.name === 'string' && instObj.name.trim()) {
        institutionName = cleanBibliographicText(instObj.name);
      }
      const rawInstPlace = instObj.place;
      if (Array.isArray(rawInstPlace) && typeof rawInstPlace[0] === 'string') {
        institutionPlace = cleanBibliographicText(rawInstPlace[0]);
      } else if (typeof rawInstPlace === 'string') {
        institutionPlace = cleanBibliographicText(rawInstPlace);
      }
    }

    const rawPublisher = cleanBibliographicText(
      typeof message.publisher === 'string' ? message.publisher : undefined,
    );
    const publisher = rawPublisher || institutionName;
    const effectivePlace = place || institutionPlace;

    const rawEdition = message['edition-number'] ?? message.edition;
    const edition =
      typeof rawEdition === 'string' && rawEdition.trim()
        ? rawEdition.trim()
        : typeof rawEdition === 'number'
          ? String(rawEdition)
          : undefined;

    const rawDegree = message.degree;
    const degreeStr = Array.isArray(rawDegree)
      ? typeof rawDegree[0] === 'string'
        ? rawDegree[0].trim()
        : undefined
      : typeof rawDegree === 'string'
        ? rawDegree.trim()
        : undefined;
    const subtypeStr =
      typeof message.subtype === 'string' && message.subtype.trim()
        ? message.subtype.trim()
        : undefined;

    const rawReportNumber =
      message['report-number'] ?? message.number ?? message['standard-number'];
    const reportNumberStr =
      typeof rawReportNumber === 'string' && rawReportNumber.trim()
        ? rawReportNumber.trim()
        : typeof rawReportNumber === 'number'
          ? String(rawReportNumber)
          : undefined;

    const volume =
      typeof message.volume === 'string' ? message.volume : undefined;
    const issue = typeof message.issue === 'string' ? message.issue : undefined;
    const rawArticleNumber =
      typeof message['article-number'] === 'string' &&
      message['article-number'].trim()
        ? message['article-number'].trim()
        : undefined;
    const pages =
      typeof message.page === 'string' && message.page.trim()
        ? normalizePageRange(message.page)
        : rawArticleNumber;

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

    const abstract = cleanAbstractText(
      typeof message.abstract === 'string' ? message.abstract : undefined,
    );

    const links = Array.isArray(message.link) ? message.link : [];
    let crossrefPdfUrl: string | undefined;
    for (const l of links) {
      if (!l || typeof l !== 'object') continue;
      const linkObj = l as Record<string, unknown>;
      if (
        linkObj['content-type'] === 'application/pdf' &&
        typeof linkObj.URL === 'string'
      ) {
        const u = linkObj.URL.trim();
        if (u) {
          crossrefPdfUrl = u;
          break;
        }
      }
    }

    const isOpenAccess = links.some((l) => {
      if (!l || typeof l !== 'object') return false;
      const linkObj = l as Record<string, unknown>;
      if (linkObj['content-type'] !== 'application/pdf') return false;
      const intendedApp =
        typeof linkObj['intended-application'] === 'string'
          ? linkObj['intended-application'].toLowerCase()
          : '';
      return (
        intendedApp !== 'text-mining' && intendedApp !== 'similarity-checking'
      );
    });
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
    const explicitShortTitle = cleanBibliographicText(rawShortTitle);
    const shortTitle =
      explicitShortTitle ||
      (subtitle && title && title !== baseTitle && baseTitle
        ? baseTitle
        : undefined);

    const rawRefByCount = message['is-referenced-by-count'];
    const citationCount =
      typeof rawRefByCount === 'number' && rawRefByCount > 0
        ? rawRefByCount
        : typeof rawRefByCount === 'string' && Number(rawRefByCount) > 0
          ? Number(rawRefByCount)
          : undefined;

    const rawRefCount = message['references-count'];
    const referenceCount =
      typeof rawRefCount === 'number' && rawRefCount > 0
        ? rawRefCount
        : typeof rawRefCount === 'string' && Number(rawRefCount) > 0
          ? Number(rawRefCount)
          : undefined;

    const university =
      itemType === 'thesis' ? institutionName || rawPublisher : undefined;
    const institution =
      itemType === 'report' || itemType === 'preprint' || itemType === 'dataset'
        ? institutionName || rawPublisher
        : institutionName;
    const thesisType = itemType === 'thesis' ? degreeStr : undefined;
    const reportType = itemType === 'report' ? subtypeStr : undefined;
    const reportNumber =
      itemType === 'report' || itemType === 'standard'
        ? reportNumberStr
        : undefined;

    return this.buildProviderResult({
      identifier: doi || title || 'crossref',
      rawPayload: message,
      confidenceScore: isDirectDoi ? 0.99 : 0.85,
      canonicalId: doi ? `doi:${doi}` : `crossref:${title}`,
      sourceUrl: rawUrl,
      isOpenAccess,
      metadata: {
        doi: doi || undefined,
        title,
        shortTitle,
        authors,
        creators,
        year,
        publicationDate,
        date: publicationDate,
        journal: itemType === 'journalArticle' ? journal : undefined,
        repository:
          itemType === 'preprint'
            ? institutionName || journal || rawPublisher
            : undefined,
        publicationTitle:
          itemType === 'journalArticle'
            ? journal
            : itemType === 'conferencePaper'
              ? proceedingsTitle || journal
              : itemType === 'bookSection'
                ? journal || series
                : itemType === 'preprint'
                  ? institutionName || journal || rawPublisher
                  : journal,
        conferenceName:
          itemType === 'conferencePaper'
            ? conferenceName && conferenceName !== (proceedingsTitle || journal)
              ? conferenceName
              : undefined
            : undefined,
        proceedingsTitle:
          itemType === 'conferencePaper'
            ? proceedingsTitle || journal
            : undefined,
        bookTitle: itemType === 'bookSection' ? journal || series : undefined,
        place: effectivePlace,
        journalAbbr,
        publisher,
        university,
        institution,
        thesisType,
        reportType,
        reportNumber,
        number: reportNumberStr,
        edition,
        volume,
        issue,
        pages,
        series,
        issn,
        isbn,
        url: rawUrl,
        abstract,
        citationCount,
        referenceCount,
        language,
        license,
        rights: license,
        archive,
        keywords: keywords.length ? keywords : undefined,
        openAccessPdfUrl: crossrefPdfUrl,
        itemType,
        libraryCatalog: 'DOI.org (Crossref)',
      },
    });
  }
}
