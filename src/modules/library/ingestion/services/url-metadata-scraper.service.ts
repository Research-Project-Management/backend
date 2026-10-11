import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  EXTRACTION_GATEWAY_PORT,
  IExtractionGatewayPort,
} from '../types/extraction-gateway.types';
import { SsrfGuardService } from '../../shared-kernel/core/services/ssrf-guard.service';
import { MetadataRoutingPolicy } from '../policies/metadata.policy';
import {
  cleanBibliographicText,
  cleanAbstractText,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
  normalizeIssn,
  extractYearFromDate,
  decodeHtmlEntities,
  parseCreatorString,
  splitAuthorString,
  isBotChallengePage,
  deriveDoiFromPublisherUrl,
} from '../../shared-kernel/utils/bibliographic.utils';

/** Canonical actor identifier for automated system-level ingestion downloads */
export const SYSTEM_INGESTION_USER_ID = 'system';

export interface ScrapedUrlResult {
  url: string;
  isPdf: boolean;
  fileBuffer?: Buffer;
  filename?: string;
  fileId?: string;
  title?: string;
  authors?: string[];
  creators?: Array<{
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType?: string;
  }>;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  issn?: string;
  year?: number;
  publicationDate?: string;
  publicationTitle?: string;
  journal?: string;
  publisher?: string;
  abstract?: string;
  keywords?: string[];
  pdfUrl?: string;
  /** Journal / periodical volume (citation_volume, prism.volume, …) */
  volume?: string;
  /** Journal issue / number (citation_issue, prism.number, …) */
  issue?: string;
  /** Page range "first-last" or single page */
  pages?: string;
  /** Language code/name as published (citation_language, dc.language, …) */
  language?: string;
  /** Place of publication (maps to Zotero `place`) */
  publisherPlace?: string;
  /** Conference / proceedings name (citation_conference_title) */
  conferenceName?: string;
  /** Containing book title for chapters (citation_inbook_title) */
  bookTitle?: string;
  /** Degree-granting / report-issuing institution */
  institution?: string;
  /** Report / technical report number */
  reportNumber?: string;
  /**
   * Zotero item type hint derived from embedded metadata
   * (journalArticle | conferencePaper | bookSection | book | thesis | report |
   *  newspaperArticle | blogPost | dataset). Hint only — callers decide.
   */
  itemType?: string;
  confidence: number;
}

/** Thrown when a redirect hop targets an unsafe destination. */
class UnsafeRedirectError extends Error {}

type MetaEntry = { key: string; value: string; alias: boolean };

/** Partial metadata from a structured fallback source (JSON-LD / COinS). */
type FallbackMeta = {
  title?: string;
  authors?: string[];
  date?: string;
  publicationTitle?: string;
  publisher?: string;
  doi?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  abstract?: string;
  keywords?: string[];
  language?: string;
  itemType?: string;
};

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 14000;
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (Academic Client; mailto:contact@flux.academic)',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** JSON-LD @type values considered bibliographic, in priority order. */
const JSONLD_TYPES = [
  'ScholarlyArticle',
  'MedicalScholarlyArticle',
  'Chapter',
  'Thesis',
  'Report',
  'Book',
  'Dataset',
  'Article',
  'NewsArticle',
  'BlogPosting',
];

const JSONLD_TYPE_TO_ITEM_TYPE: Record<string, string | undefined> = {
  ScholarlyArticle: 'journalArticle',
  MedicalScholarlyArticle: 'journalArticle',
  Chapter: 'bookSection',
  Thesis: 'thesis',
  Report: 'report',
  Book: 'book',
  Dataset: 'dataset',
  NewsArticle: 'newspaperArticle',
  BlogPosting: 'blogPost',
  Article: undefined,
};

@Injectable()
export class UrlMetadataScraperService {
  private readonly logger = new Logger(UrlMetadataScraperService.name);

  constructor(
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(EXTRACTION_GATEWAY_PORT)
    private readonly extractionGateway?: IExtractionGatewayPort,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
  ) {}

  /**
   * Extracts a readable title and filename hint from the URL pathname slug.
   */
  extractSlugMetadata(rawUrl: string): { title?: string; filename: string } {
    try {
      const parsed = new URL(rawUrl);
      const pathname = parsed.pathname;
      const lastSeg = pathname.split('/').filter(Boolean).pop() || '';
      const rawFilename = decodeURIComponent(lastSeg) || 'document.pdf';

      const isPdf =
        pathname.toLowerCase().endsWith('.pdf') ||
        rawFilename.toLowerCase().endsWith('.pdf') ||
        pathname.toLowerCase().includes('/pdf/');

      const filename = isPdf
        ? rawFilename.toLowerCase().endsWith('.pdf')
          ? rawFilename
          : `${rawFilename}.pdf`
        : rawFilename;

      const slugWithoutExt = rawFilename
        .replace(/\.(pdf|html?|php|aspx?)$/i, '')
        .trim();

      let cleanSlug = slugWithoutExt.replace(
        /^(\d{4,8}[-_]|v\d+[-_]|[0-9a-f]{16,}[-_])+/i,
        '',
      );
      cleanSlug = cleanSlug.replace(/[-_](abstract|paper|supplemental)$/i, '');

      const words = cleanSlug
        .split(/[-_+.\s]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      const genericWords = new Set([
        'download',
        'document',
        'paper',
        'file',
        'view',
        'viewcontent',
        'content',
        'pdf',
        'main',
        'fulltext',
        'article',
      ]);

      const meaningfulWords = words.filter(
        (w) =>
          !genericWords.has(w.toLowerCase()) &&
          /^[A-Za-z\u00C0-\u024F]{3,}$/.test(w),
      );

      let title: string | undefined;
      if (meaningfulWords.length >= 2) {
        const rawTitle = words.join(' ');
        title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
      }

      return { title, filename };
    } catch {
      return { filename: 'document.pdf' };
    }
  }

  private async assertSafeUrl(url: string): Promise<void> {
    if (this.ssrfGuard) {
      await this.ssrfGuard.assertSafeUrl(url);
    } else {
      MetadataRoutingPolicy.validateUrl(url);
    }
  }

  private async fetchWithSafeRedirects(
    startUrl: string,
  ): Promise<{ response: Response; finalUrl: string }> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let currentUrl = startUrl;

    for (let hop = 0; ; hop++) {
      const res = await fetch(currentUrl, {
        headers: FETCH_HEADERS,
        signal,
        redirect: 'manual',
      });

      const status = res.status;
      const location =
        typeof status === 'number' && status >= 300 && status < 400
          ? res.headers?.get?.('location')
          : null;
      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }

      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }

      if (hop >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new UnsafeRedirectError(`Invalid redirect target "${location}"`);
      }
      if (!/^https?:$/i.test(new URL(nextUrl).protocol)) {
        throw new UnsafeRedirectError(
          `Redirect to non-HTTP scheme rejected: "${nextUrl}"`,
        );
      }
      try {
        await this.assertSafeUrl(nextUrl);
      } catch (err: any) {
        throw new UnsafeRedirectError(
          `Redirect target "${nextUrl}" rejected: ${err?.message}`,
        );
      }
      currentUrl = nextUrl;
    }
  }

  async scrape(
    url: string,
    options?: {
      scopeId?: string;
      userId?: string;
      preferredFilename?: string;
    },
  ): Promise<ScrapedUrlResult> {
    const canonicalUrl = url.trim();
    const slugHint = this.extractSlugMetadata(canonicalUrl);
    const urlDoi = deriveDoiFromPublisherUrl(canonicalUrl);

    const fallbackResult = (): ScrapedUrlResult => ({
      url: canonicalUrl,
      isPdf: false,
      title: slugHint.title,
      filename: slugHint.filename,
      doi: urlDoi || undefined,
      confidence: 0.5,
    });

    try {
      await this.assertSafeUrl(canonicalUrl);
    } catch (ssrfErr: any) {
      this.logger.warn(
        `SSRF rejection for URL "${canonicalUrl}": ${ssrfErr?.message}`,
      );
      return fallbackResult();
    }

    let response: Response;
    let finalUrl = canonicalUrl;
    try {
      const fetched = await this.fetchWithSafeRedirects(canonicalUrl);
      response = fetched.response;
      finalUrl = fetched.finalUrl;
    } catch (fetchErr: any) {
      if (fetchErr instanceof UnsafeRedirectError) {
        this.logger.warn(
          `SSRF rejection on redirect for URL "${canonicalUrl}": ${fetchErr.message}`,
        );
      } else {
        this.logger.warn(
          `Failed to fetch URL "${canonicalUrl}": ${fetchErr?.message}`,
        );
      }
      return fallbackResult();
    }

    if (!response.ok) {
      this.logger.warn(
        `HTTP ${response.status} when fetching URL "${canonicalUrl}"`,
      );
      return fallbackResult();
    }

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    const isPdfContent =
      contentType.includes('application/pdf') ||
      canonicalUrl.toLowerCase().endsWith('.pdf') ||
      new URL(canonicalUrl).pathname.toLowerCase().endsWith('.pdf') ||
      new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf');

    if (isPdfContent) {
      try {
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        const isPdfMagic =
          buffer.length >= 4 &&
          buffer[0] === 0x25 &&
          buffer[1] === 0x50 &&
          buffer[2] === 0x44 &&
          buffer[3] === 0x46;

        if (isPdfMagic) {
          const effectiveFilename =
            options?.preferredFilename || slugHint.filename;
          let fileId: string | undefined;

          if (this.storagePort) {
            try {
              const uploadRes = await this.storagePort.uploadFile({
                userId: options?.userId || SYSTEM_INGESTION_USER_ID,
                filename: effectiveFilename,
                buffer,
                mimeType: 'application/pdf',
                projectId:
                  options?.scopeId && options.scopeId !== 'user'
                    ? options.scopeId
                    : undefined,
                source: 'url_pdf_download',
              });
              fileId = uploadRes?.fileId;
              this.logger.log(
                `Stored downloaded PDF for "${canonicalUrl}" with fileId: ${fileId}`,
              );
            } catch (storageErr: any) {
              this.logger.warn(
                `Failed to persist downloaded PDF to storage: ${storageErr?.message}`,
              );
            }
          }

          let pdfExtracted: any = {};
          if (this.extractionGateway?.extractDocumentFromBuffer) {
            try {
              const doc =
                await this.extractionGateway.extractDocumentFromBuffer(buffer, {
                  headerOnly: true,
                });
              pdfExtracted = doc?.metadata || {};
            } catch (pdfErr: any) {
              this.logger.warn(
                `ExtractionGateway pdf extraction failed: ${pdfErr?.message}`,
              );
            }
          }

          let binaryDoi: string | undefined;
          const scanBuffer = buffer
            .slice(0, Math.min(buffer.length, 65536))
            .toString('utf-8');
          const doiMatch = scanBuffer.match(
            /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)\b/i,
          );
          if (doiMatch) {
            binaryDoi = normalizeDoi(doiMatch[1]);
          }

          let binaryArxiv: string | undefined;
          const arxivMatch = scanBuffer.match(
            /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b/i,
          );
          if (arxivMatch) {
            binaryArxiv = normalizeArxivId(arxivMatch[1]);
          }

          const resolvedDoi = pdfExtracted.doi || binaryDoi;
          const resolvedArxiv = pdfExtracted.arxivId || binaryArxiv;
          const resolvedTitle =
            pdfExtracted.title &&
            pdfExtracted.title !== 'Untitled Document' &&
            pdfExtracted.title.length > 5
              ? pdfExtracted.title
              : slugHint.title;

          return {
            url: canonicalUrl,
            isPdf: true,
            fileBuffer: buffer,
            filename: effectiveFilename,
            fileId,
            title: resolvedTitle,
            authors: pdfExtracted.authors,
            creators: pdfExtracted.creators,
            doi: resolvedDoi,
            arxivId: resolvedArxiv,
            year: pdfExtracted.year,
            publicationDate: pdfExtracted.publicationDate,
            publicationTitle:
              pdfExtracted.journal || pdfExtracted.conferenceName,
            journal: pdfExtracted.journal,
            publisher: pdfExtracted.publisher,
            abstract: pdfExtracted.abstract,
            keywords: pdfExtracted.keywords,
            confidence:
              resolvedDoi || resolvedArxiv ? 0.95 : resolvedTitle ? 0.85 : 0.7,
          };
        }
      } catch (pdfProcessErr: any) {
        this.logger.warn(
          `Error downloading/processing PDF from "${canonicalUrl}": ${pdfProcessErr?.message}`,
        );
      }
    }

    try {
      const htmlText = await response.text();

      if (isBotChallengePage(htmlText)) {
        this.logger.warn(
          `Bot-challenge page detected for "${canonicalUrl}" — ignoring page metadata${urlDoi ? `, using URL-derived DOI ${urlDoi}` : ''}`,
        );
        return {
          url: canonicalUrl,
          isPdf: false,
          filename: slugHint.filename,
          title: urlDoi ? undefined : slugHint.title,
          doi: urlDoi || undefined,
          confidence: urlDoi ? 0.9 : 0.3,
        };
      }

      const parsedHtml = this.extractHtmlMetadata(htmlText, finalUrl);
      const resolvedDoi = parsedHtml.doi || urlDoi || undefined;

      const resolvedTitle = parsedHtml.title || slugHint.title;
      return {
        url: canonicalUrl,
        isPdf: false,
        filename: slugHint.filename,
        title: resolvedTitle,
        authors: parsedHtml.authors,
        creators: parsedHtml.creators,
        doi: resolvedDoi,
        arxivId: parsedHtml.arxivId,
        pmid: parsedHtml.pmid,
        isbn: parsedHtml.isbn,
        issn: parsedHtml.issn,
        year: parsedHtml.year,
        publicationDate: parsedHtml.publicationDate,
        publicationTitle: parsedHtml.publicationTitle,
        journal: parsedHtml.journal,
        publisher: parsedHtml.publisher,
        abstract: parsedHtml.abstract,
        keywords: parsedHtml.keywords,
        pdfUrl: parsedHtml.pdfUrl,
        volume: parsedHtml.volume,
        issue: parsedHtml.issue,
        pages: parsedHtml.pages,
        language: parsedHtml.language,
        publisherPlace: parsedHtml.publisherPlace,
        conferenceName: parsedHtml.conferenceName,
        bookTitle: parsedHtml.bookTitle,
        institution: parsedHtml.institution,
        reportNumber: parsedHtml.reportNumber,
        itemType: parsedHtml.itemType,
        confidence:
          resolvedDoi || parsedHtml.arxivId || parsedHtml.pmid
            ? 0.95
            : resolvedTitle
              ? 0.85
              : 0.6,
      };
    } catch (htmlErr: any) {
      this.logger.warn(
        `Error parsing HTML from "${canonicalUrl}": ${htmlErr?.message}`,
      );
      return {
        url: canonicalUrl,
        isPdf: false,
        filename: slugHint.filename,
        title: slugHint.title,
        doi: urlDoi || undefined,
        confidence: 0.5,
      };
    }
  }

  extractHtmlMetadata(
    html: string,
    pageUrl: string,
  ): Partial<ScrapedUrlResult> {
    const entries = this.parseMetaEntries(html);
    const metaTags = this.buildMetaMap(entries);
    const all = (...keys: string[]) => this.collectMetaValues(entries, keys);
    const first = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = metaTags[k];
        if (v && v.trim()) return v.trim();
      }
      return undefined;
    };
    const jsonLd = this.extractJsonLdMetadata(html);
    const coins = this.extractCoinsMetadata(html);
    const result: Partial<ScrapedUrlResult> = {};

    let rawTitle =
      first('citation_title', 'eprints.title', 'dc.title', 'dcterms.title') ||
      jsonLd.title ||
      coins.title ||
      first('og:title', 'twitter:title');
    if (!rawTitle) {
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTagMatch && titleTagMatch[1]) {
        let cleanTag = decodeHtmlEntities(titleTagMatch[1]).trim();
        cleanTag = cleanTag
          .replace(
            /\s*(\||—|-)\s*(NeurIPS|CVPR|ICCV|ECCV|ICLR|ICML|AAAI|ACL|ScienceDirect|SpringerLink|Nature|IEEE\s*Xplore|arXiv|ACM\s*Digital\s*Library|PubMed|Wiley\s*Online\s*Library|PLOS|Frontiers|ResearchGate|Semantic\s*Scholar|OpenReview).*$/i,
            '',
          )
          .trim();
        if (cleanTag.length >= 3) {
          rawTitle = cleanTag;
        }
      }
    }

    if (rawTitle) {
      result.title = cleanBibliographicText(rawTitle) || rawTitle;
    }

    let rawAuthors = all('citation_author');
    if (rawAuthors.length === 0) rawAuthors = all('citation_authors');
    if (rawAuthors.length === 0) rawAuthors = all('eprints.creators_name');
    if (rawAuthors.length === 0) {
      rawAuthors = all('dc.creator', 'dcterms.creator');
    }
    if (rawAuthors.length === 0 && jsonLd.authors?.length) {
      rawAuthors = jsonLd.authors;
    }
    if (rawAuthors.length === 0 && coins.authors?.length) {
      rawAuthors = coins.authors;
    }
    const authors = this.dedupeNames(rawAuthors);
    const editors = this.dedupeNames(
      all('citation_editor', 'eprints.editors_name'),
    );
    if (authors.length > 0) {
      result.authors = authors;
    }
    const creators = [
      ...authors.map((a, idx) => this.toCreator(a, idx, 'author')),
      ...editors.map((e, idx) => this.toCreator(e, idx, 'editor')),
    ];
    if (creators.length > 0) {
      result.creators = creators;
    }

    for (const cand of [
      first('citation_doi'),
      first('prism.doi'),
      ...all('dc.identifier', 'dcterms.identifier', 'eprints.id_number'),
      jsonLd.doi,
      coins.doi,
    ]) {
      const d = cand ? normalizeDoi(cand) : undefined;
      if (d) {
        result.doi = d;
        break;
      }
    }
    if (!result.doi) {
      const urlDoi = deriveDoiFromPublisherUrl(pageUrl);
      if (urlDoi) result.doi = urlDoi;
    }
    if (!result.doi) {
      const counts = new Map<string, number>();
      const doiRe = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)\b/gi;
      let m: RegExpExecArray | null;
      while ((m = doiRe.exec(html)) !== null) {
        if (m[1].includes('schema.org')) continue;
        const d = normalizeDoi(m[1]);
        if (d) counts.set(d, (counts.get(d) || 0) + 1);
      }
      let best: string | undefined;
      let bestCount = 0;
      for (const [d, c] of counts) {
        if (c > bestCount) {
          best = d;
          bestCount = c;
        }
      }
      if (best && bestCount >= 2) {
        result.doi = best;
      }
    }

    const rawArxiv = first('citation_arxiv_id');
    if (rawArxiv) {
      result.arxivId = normalizeArxivId(rawArxiv);
    }

    const rawPmid = first('citation_pmid');
    if (rawPmid) {
      result.pmid = normalizePmid(rawPmid);
    }

    for (const cand of [
      ...all(
        'citation_issn',
        'citation_eissn',
        'prism.issn',
        'prism.eissn',
        'eprints.issn',
      ),
      jsonLd.issn,
      coins.issn,
    ]) {
      const v = cand ? normalizeIssn(cand) : undefined;
      if (v) {
        result.issn = v;
        break;
      }
    }

    for (const cand of [
      ...all('citation_isbn', 'prism.isbn', 'eprints.isbn'),
      jsonLd.isbn,
      coins.isbn,
    ]) {
      const v = cand ? normalizeIsbn(cand) : undefined;
      if (v) {
        result.isbn = v;
        break;
      }
    }

    const rawDate =
      first(
        'citation_publication_date',
        'citation_date',
        'citation_cover_date',
        'prism.publicationdate',
        'prism.coverdate',
        'dc.date',
        'dcterms.issued',
        'dcterms.date',
        'eprints.date',
        'citation_online_date',
        'prism.onlinedate',
      ) ||
      jsonLd.date ||
      coins.date;
    if (rawDate) {
      result.publicationDate = rawDate.trim();
      result.year = extractYearFromDate(rawDate);
    } else {
      const urlDateMatch = pageUrl.match(
        /(?:^|\/)((?:19|20)\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])(?:\/|[?#]|$)/,
      );
      if (urlDateMatch) {
        result.publicationDate = `${urlDateMatch[1]}-${urlDateMatch[2]}-${urlDateMatch[3]}`;
        result.year = parseInt(urlDateMatch[1], 10);
      }
    }

    const journalTitle = this.cleanText(
      first(
        'citation_journal_title',
        'prism.publicationname',
        'eprints.publication',
        'dc.source',
      ),
    );
    const conferenceName = this.cleanText(
      first(
        'citation_conference_title',
        'citation_conference',
        'eprints.event_title',
      ),
    );
    const bookTitle = this.cleanText(
      first(
        'citation_inbook_title',
        'citation_book_title',
        'eprints.book_title',
      ),
    );
    const seriesTitle = this.cleanText(first('citation_series_title'));
    const fallbackVenue = this.cleanText(
      jsonLd.publicationTitle || coins.publicationTitle,
    );
    if (conferenceName) result.conferenceName = conferenceName;
    if (bookTitle) result.bookTitle = bookTitle;

    const venue =
      journalTitle ||
      conferenceName ||
      bookTitle ||
      seriesTitle ||
      fallbackVenue;
    if (venue) {
      result.publicationTitle = venue;
      if (venue !== bookTitle) result.journal = venue;
    }

    const pub = first(
      'citation_publisher',
      'dc.publisher',
      'dcterms.publisher',
      'eprints.publisher',
      'prism.publisher',
    );
    const cleanPub = this.cleanText(pub || jsonLd.publisher);
    if (cleanPub) {
      result.publisher = cleanPub;
    }
    const place = this.cleanText(
      first(
        'citation_publisher_place',
        'citation_publication_place',
        'eprints.place_of_pub',
      ),
    );
    if (place) result.publisherPlace = place;

    const thesisInstitution = this.cleanText(
      first('citation_dissertation_institution'),
    );
    const reportInstitution = this.cleanText(
      first('citation_technical_report_institution'),
    );
    const eprintsInstitution = this.cleanText(first('eprints.institution'));
    const institution =
      thesisInstitution || reportInstitution || eprintsInstitution;
    if (institution) result.institution = institution;
    const reportNumber = first(
      'citation_technical_report_number',
      'eprints.number_report',
    );
    if (reportNumber) result.reportNumber = reportNumber;

    const volume =
      first('citation_volume', 'prism.volume', 'eprints.volume') ||
      jsonLd.volume ||
      coins.volume;
    if (volume) result.volume = volume;

    const issue =
      first(
        'citation_issue',
        'prism.number',
        'prism.issueidentifier',
        'eprints.number',
      ) ||
      jsonLd.issue ||
      coins.issue;
    if (issue) result.issue = issue;

    const pages =
      this.joinPages(first('citation_firstpage'), first('citation_lastpage')) ||
      this.joinPages(first('prism.startingpage'), first('prism.endingpage')) ||
      first('prism.pagerange', 'eprints.pagerange') ||
      jsonLd.pages ||
      coins.pages;
    if (pages) result.pages = pages;

    const language =
      first(
        'citation_language',
        'dc.language',
        'dcterms.language',
        'eprints.language',
      ) || jsonLd.language;
    if (language) result.language = language;

    const eprintsType = (first('eprints.type') || '').toLowerCase();
    if (thesisInstitution || eprintsType === 'thesis') {
      result.itemType = 'thesis';
    } else if (
      reportInstitution ||
      reportNumber ||
      eprintsType === 'monograph'
    ) {
      result.itemType = 'report';
    } else if (conferenceName || eprintsType === 'conference_item') {
      result.itemType = 'conferencePaper';
    } else if (bookTitle || eprintsType === 'book_section') {
      result.itemType = 'bookSection';
    } else if (journalTitle || eprintsType === 'article') {
      result.itemType = 'journalArticle';
    } else if (eprintsType === 'book') {
      result.itemType = 'book';
    } else if (jsonLd.itemType) {
      result.itemType = jsonLd.itemType;
    } else if (coins.itemType) {
      result.itemType = coins.itemType;
    } else if (/\/blogs?\//i.test(pageUrl)) {
      result.itemType = 'blogPost';
    }

    const pdfUrl = first(
      'citation_pdf_url',
      'citation_fulltext_html_url',
      'eprints.document_url',
      'bepress_citation_pdf_url',
    );
    if (pdfUrl) {
      try {
        result.pdfUrl = new URL(pdfUrl, pageUrl).toString();
      } catch {
        result.pdfUrl = pdfUrl;
      }
    }

    let rawAbstract =
      first(
        'citation_abstract',
        'eprints.abstract',
        'dcterms.abstract',
        'dc.description',
      ) ||
      jsonLd.abstract ||
      coins.abstract;
    if (!rawAbstract) {
      const og = first('og:description');
      if (og && og.length >= 200) rawAbstract = og;
    }
    if (rawAbstract) {
      const cleanedAbstract = cleanAbstractText(rawAbstract);
      if (cleanedAbstract) result.abstract = cleanedAbstract;
    }

    let keywordValues = all('citation_keywords', 'citation_keyword');
    if (keywordValues.length === 0) {
      keywordValues = all('eprints.keywords', 'dc.subject', 'dcterms.subject');
    }
    if (keywordValues.length === 0 && jsonLd.keywords?.length) {
      keywordValues = jsonLd.keywords;
    }
    let keywords = this.splitKeywords(keywordValues);
    if (keywords.length === 0) {
      const generic = this.splitKeywords(all('keywords'));
      if (this.looksLikeKeywordList(generic)) keywords = generic;
    }
    if (keywords.length > 0) {
      result.keywords = keywords;
    }

    return result;
  }

  private cleanText(v?: string): string | undefined {
    if (!v) return undefined;
    return cleanBibliographicText(v) || undefined;
  }

  private joinPages(firstPage?: string, lastPage?: string): string | undefined {
    const f = firstPage?.trim();
    const l = lastPage?.trim();
    if (!f) return undefined;
    if (/[-–]/.test(f) || !l || l === f) return f;
    return `${f}-${l}`;
  }

  private dedupeNames(raw: string[]): string[] {
    const seen = new Set<string>();
    return raw
      .flatMap((a) => splitAuthorString(a))
      .filter((a) => {
        const key = a.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  private toCreator(
    name: string,
    idx: number,
    creatorType: string,
  ): {
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType?: string;
  } {
    const parsed = parseCreatorString(name, idx);
    return {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      fullName: parsed.fullName,
      creatorType,
    };
  }

  private splitKeywords(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
      for (const k of v.split(/[,;]/)) {
        const t = k.trim();
        const key = t.toLowerCase();
        if (t && !seen.has(key)) {
          seen.add(key);
          out.push(t);
        }
      }
    }
    return out;
  }

  private looksLikeKeywordList(items: string[]): boolean {
    if (items.length < 2 || items.length > 30) return false;
    return items.every(
      (k) => k.length <= 60 && k.split(/\s+/).length <= 6 && !/[.!?]$/.test(k),
    );
  }

  private parseMetaEntries(html: string): MetaEntry[] {
    const entries: MetaEntry[] = [];
    const tagRe = /<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
    let tagMatch: RegExpExecArray | null;

    while ((tagMatch = tagRe.exec(html)) !== null) {
      const attrs = this.parseAttributes(tagMatch[1]);
      const content = attrs['content'];
      if (content === undefined) continue;
      const value = decodeHtmlEntities(content).trim();
      if (!value) continue;

      for (const attrName of ['name', 'property', 'itemprop']) {
        const rawKey = attrs[attrName];
        if (!rawKey) continue;
        for (const k of rawKey.split(/\s+/).filter(Boolean)) {
          let key = k.trim().toLowerCase();
          key = key.replace(/^(dc|dcterms|prism|eprints):/, '$1.');
          if (key.startsWith('bepress_citation_')) {
            entries.push({ key, value, alias: false });
            entries.push({
              key: key.replace(/^bepress_/, ''),
              value,
              alias: true,
            });
          } else {
            entries.push({ key, value, alias: false });
          }
        }
      }
    }
    return entries;
  }

  private parseAttributes(attrText: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
      const name = m[1].toLowerCase();
      if (attrs[name] !== undefined) continue;
      attrs[name] = m[3] ?? m[4] ?? m[5] ?? '';
    }
    return attrs;
  }

  private buildMetaMap(entries: MetaEntry[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const pass of [false, true]) {
      for (const e of entries) {
        if (e.alias === pass && !map[e.key]) map[e.key] = e.value;
      }
    }
    return map;
  }

  private collectMetaValues(entries: MetaEntry[], keys: string[]): string[] {
    const targets = new Set(keys.map((k) => k.toLowerCase()));
    const native = entries.filter((e) => !e.alias && targets.has(e.key));
    if (native.length > 0) return native.map((e) => e.value);
    return entries
      .filter((e) => e.alias && targets.has(e.key))
      .map((e) => e.value);
  }

  private extractJsonLdMetadata(html: string): FallbackMeta {
    const out: FallbackMeta = {};
    const nodes: any[] = [];
    const scriptRe =
      /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(html)) !== null) {
      const raw = m[1]
        .trim()
        .replace(/^<!--|-->$/g, '')
        .trim();
      if (!raw) continue;
      try {
        this.flattenJsonLd(JSON.parse(raw), nodes, 0);
      } catch {
        /* malformed JSON-LD — ignore */
      }
    }
    if (nodes.length === 0) return out;

    const typesOf = (n: any): string[] =>
      (Array.isArray(n?.['@type']) ? n['@type'] : [n?.['@type']])
        .filter((t: any) => typeof t === 'string')
        .map((t: string) => t.replace(/^.*[/#:]/, ''));

    let node: any;
    let nodeType: string | undefined;
    for (const t of JSONLD_TYPES) {
      node = nodes.find((n) => typesOf(n).includes(t));
      if (node) {
        nodeType = t;
        break;
      }
    }
    if (!node || !nodeType) return out;

    const str = (v: any): string | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'string' || typeof v === 'number') {
        const s = decodeHtmlEntities(String(v)).trim();
        return s || undefined;
      }
      if (Array.isArray(v)) return str(v[0]);
      if (typeof v === 'object') return str(v.name ?? v['@value'] ?? v.value);
      return undefined;
    };
    const arr = (v: any): any[] =>
      v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

    out.itemType = JSONLD_TYPE_TO_ITEM_TYPE[nodeType];
    out.title = str(node.headline) || str(node.name);

    const authors: string[] = [];
    for (const a of arr(node.author ?? node.creator)) {
      if (typeof a === 'string') {
        const s = str(a);
        if (s) authors.push(s);
      } else if (a && typeof a === 'object') {
        const given = str(a.givenName);
        const family = str(a.familyName);
        const name =
          given || family
            ? [given, family].filter(Boolean).join(' ')
            : str(a.name);
        if (name) authors.push(name);
      }
    }
    if (authors.length) out.authors = authors;

    out.date = str(node.datePublished) || str(node.dateCreated);
    out.abstract = str(node.description) || str(node.abstract);
    out.volume = str(node.volumeNumber);
    out.issue = str(node.issueNumber);
    out.pages =
      str(node.pagination) ||
      this.joinPages(str(node.pageStart), str(node.pageEnd));
    out.isbn = str(node.isbn);
    out.issn = str(node.issn);
    out.language = str(node.inLanguage);

    const kw = node.keywords;
    if (typeof kw === 'string') {
      out.keywords = kw
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean);
    } else if (Array.isArray(kw)) {
      out.keywords = kw.map((k) => str(k)).filter((k): k is string => !!k);
    }

    let container = arr(node.isPartOf)[0];
    for (let depth = 0; container && depth < 4; depth++) {
      if (typeof container === 'string') {
        out.publicationTitle = out.publicationTitle || str(container);
        break;
      }
      const ctypes = typesOf(container);
      if (ctypes.includes('PublicationIssue')) {
        out.issue = out.issue || str(container.issueNumber);
      } else if (ctypes.includes('PublicationVolume')) {
        out.volume = out.volume || str(container.volumeNumber);
      } else {
        out.publicationTitle = out.publicationTitle || str(container.name);
      }
      out.issn = out.issn || str(container.issn);
      out.isbn = out.isbn || str(container.isbn);
      container = arr(container.isPartOf)[0];
    }

    out.publisher = str(node.publisher);

    const idCandidates: string[] = [];
    for (const id of arr(node.identifier)) {
      if (typeof id === 'string') idCandidates.push(id);
      else if (id && typeof id === 'object') {
        const prop = String(id.propertyID || '').toLowerCase();
        const val = str(id.value ?? id['@id']);
        if (val && (!prop || prop === 'doi' || /10\.\d{4,9}\//.test(val))) {
          idCandidates.push(val);
        }
      }
    }
    for (const s of arr(node.sameAs))
      if (typeof s === 'string') idCandidates.push(s);
    if (typeof node['@id'] === 'string') idCandidates.push(node['@id']);
    for (const c of idCandidates) {
      if (!/10\.\d{4,9}\//.test(c)) continue;
      const d = normalizeDoi(c);
      if (d) {
        out.doi = d;
        break;
      }
    }

    return out;
  }

  private flattenJsonLd(value: any, acc: any[], depth: number): void {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) this.flattenJsonLd(v, acc, depth + 1);
      return;
    }
    if (value['@type']) acc.push(value);
    if (Array.isArray(value['@graph'])) {
      this.flattenJsonLd(value['@graph'], acc, depth + 1);
    }
    if (value.mainEntity && typeof value.mainEntity === 'object') {
      this.flattenJsonLd(value.mainEntity, acc, depth + 1);
    }
  }

  private extractCoinsMetadata(html: string): FallbackMeta {
    const out: FallbackMeta = {};
    const spanRe = /<span\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
    let m: RegExpExecArray | null;
    let ctx: string | undefined;
    while ((m = spanRe.exec(html)) !== null) {
      const attrs = this.parseAttributes(m[1]);
      if (!/\bZ3988\b/.test(attrs['class'] || '')) continue;
      if (attrs['title']) {
        ctx = attrs['title'];
        break;
      }
    }
    if (!ctx) return out;

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(decodeHtmlEntities(ctx));
    } catch {
      return out;
    }
    const get = (k: string): string | undefined => {
      const v = params.get(k);
      return v && v.trim() ? v.trim() : undefined;
    };

    out.title = get('rft.atitle') || get('rft.title') || get('rft.btitle');

    const authors = params
      .getAll('rft.au')
      .map((a) => a.trim())
      .filter(Boolean);
    if (authors.length === 0) {
      const last = get('rft.aulast');
      const firstName = get('rft.aufirst');
      if (last) authors.push(firstName ? `${firstName} ${last}` : last);
    }
    if (authors.length) out.authors = authors;

    out.date = get('rft.date');
    out.publicationTitle =
      get('rft.jtitle') || (get('rft.atitle') ? get('rft.btitle') : undefined);
    out.volume = get('rft.volume');
    out.issue = get('rft.issue');
    out.pages =
      this.joinPages(get('rft.spage'), get('rft.epage')) || get('rft.pages');
    out.issn = get('rft.issn') || get('rft.eissn');
    out.isbn = get('rft.isbn');
    out.publisher = get('rft.pub');

    for (const id of params.getAll('rft_id')) {
      if (/^info:doi\//i.test(id) || /doi\.org\//i.test(id)) {
        const d = normalizeDoi(id.replace(/^info:doi\//i, ''));
        if (d) {
          out.doi = d;
          break;
        }
      }
    }

    const genre = (get('rft.genre') || '').toLowerCase();
    const fmt = (get('rft_val_fmt') || '').toLowerCase();
    if (fmt.includes('dissertation')) out.itemType = 'thesis';
    else if (genre === 'proceeding' || genre === 'conference')
      out.itemType = 'conferencePaper';
    else if (genre === 'bookitem') out.itemType = 'bookSection';
    else if (genre === 'book') out.itemType = 'book';
    else if (genre === 'report') out.itemType = 'report';
    else if (genre === 'article' || fmt.includes('journal'))
      out.itemType = 'journalArticle';

    return out;
  }
}
