import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '../domain/metadata.types';
import {
  normalizeDoi,
  normalizeIsbn,
  normalizeIssn,
  cleanBibliographicText,
  cleanAbstractText,
  titleSimilarity,
  TITLE_MATCH_THRESHOLD,
} from './metadata.utils';
import { ProviderFetchError } from '../services/metadata-executor.service';
import { getAcademicContactEmail } from '../../../shared-kernel/core/constants/academic-client.constants';
import {
  CSL_TYPE_TO_ITEM_TYPE,
  normalizePageRange,
} from '../../../shared-kernel/utils/bibliographic.utils';

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
    return getAcademicContactEmail();
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

    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleanTitle)}&rows=5&mailto=${encodeURIComponent(this.mailto)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.mailto}; https://flux.study)`,
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
    const items = payload?.message?.items || [];

    // Never trust the top hit blindly: Crossref's bibliographic search always
    // returns *something* (e.g. "Client Challenge" → "The client/server
    // challenge", 1995). Pick the best title match above the threshold.
    let best: Record<string, unknown> | undefined;
    let bestScore = 0;
    for (const candidate of items) {
      const candTitle = Array.isArray(candidate.title)
        ? String(candidate.title[0] ?? '')
        : typeof candidate.title === 'string'
          ? candidate.title
          : '';
      const score = titleSimilarity(cleanTitle, candTitle);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || bestScore < TITLE_MATCH_THRESHOLD) {
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
    const baseTitle = cleanBibliographicText(rawTitleStr) || 'Untitled';

    // Zotero Crossref translator: append subtitle as "Title: Subtitle"
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
        : baseTitle;

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

            // Organizational / single-field creator: { name } without given/family
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
    // Zotero Crossref translator maps conference chairs to "contributor"
    addCreators(message.chair, 'contributor');

    let year: number | null = null;
    let publicationDate: string | undefined = undefined;
    const pubPrint = message['published-print'] as
      { 'date-parts'?: number[][] } | undefined;
    const pubOnline = message['published-online'] as
      { 'date-parts'?: number[][] } | undefined;
    const issued = message.issued as { 'date-parts'?: number[][] } | undefined;

    // Zotero Crossref translator: "issued" is the canonical publication date
    const dateParts = [issued, pubPrint, pubOnline]
      .map((d) => d?.['date-parts']?.[0])
      .find((parts) => Array.isArray(parts) && !!parts[0]);
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
    // Crossref "type" → Zotero itemType (mirrors Zotero's Crossref REST translator).
    // Only "journal-article" maps to journalArticle; unknown types fall back
    // to "document" rather than silently becoming journal articles.
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
        ? (message['publisher-location'] as string)
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

    const rawVersion = createHash('md5')
      .update(JSON.stringify(message))
      .digest('hex');

    const publisher = cleanBibliographicText(
      typeof message.publisher === 'string' ? message.publisher : undefined,
    );
    const volume =
      typeof message.volume === 'string' ? message.volume : undefined;
    const issue = typeof message.issue === 'string' ? message.issue : undefined;
    const pages =
      typeof message.page === 'string'
        ? normalizePageRange(message.page)
        : undefined;

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

    return {
      provider: this.id,
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
        publicationTitle:
          itemType === 'journalArticle'
            ? journal
            : itemType === 'conferencePaper'
              ? proceedingsTitle || journal
              : itemType === 'bookSection'
                ? journal || series
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
        place,
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
        citationCount,
        referenceCount,
        language,
        license,
        rights: license,
        archive,
        keywords: keywords.length ? keywords : undefined,
        itemType,
        // Zotero spec: libraryCatalog identifies the upstream authority source
        libraryCatalog: 'DOI.org (Crossref)',
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
