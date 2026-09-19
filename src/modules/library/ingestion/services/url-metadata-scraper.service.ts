import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { PdfProvider } from '../../attachments/providers/pdf.provider';
import { SsrfGuardService } from '../../core/services/ssrf-guard.service';
import { MetadataRoutingPolicy } from '../metadata/policies/metadata.policy';
import {
  normalizeAcademicTitleCase,
  cleanBibliographicText,
  cleanAbstractText,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  extractYearFromDate,
  decodeHtmlEntities,
  parseCreatorString,
} from '../../items/utils/items.utils';

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
  confidence: number;
}

@Injectable()
export class UrlMetadataScraperService {
  private readonly logger = new Logger(UrlMetadataScraperService.name);

  constructor(
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional() private readonly pdf?: PdfProvider,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
  ) {}

  /**
   * Extracts a readable title and filename hint from the URL pathname slug.
   * e.g. "https://proceedings.neurips.cc/paper/7181-attention-is-all-you-need.pdf"
   * -> filename: "7181-attention-is-all-you-need.pdf"
   * -> title: "Attention Is All You Need"
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

      // Remove leading IDs or hash prefixes like "7181-", "2017-", "v1-"
      let cleanSlug = slugWithoutExt.replace(
        /^(\d{4,8}[-_]|v\d+[-_]|[0-9a-f]{16,}[-_])+/i,
        '',
      );
      // Remove trailing hash suffixes like "-Abstract" or "-Paper"
      cleanSlug = cleanSlug.replace(/[-_](abstract|paper|supplemental)$/i, '');

      // Check if the remaining slug has reasonable textual content
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
        (w) => !genericWords.has(w.toLowerCase()) && !/^\d+$/.test(w),
      );

      let title: string | undefined;
      if (
        meaningfulWords.length >= 2 ||
        (words.length >= 3 && cleanSlug.length >= 10)
      ) {
        const rawTitle = words.join(' ');
        title = normalizeAcademicTitleCase(rawTitle);
      }

      return { title, filename };
    } catch {
      return { filename: 'document.pdf' };
    }
  }

  /**
   * Scrapes metadata and files from an academic or general URL.
   */
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

    // 1. SSRF verification
    try {
      if (this.ssrfGuard) {
        await this.ssrfGuard.assertSafeUrl(canonicalUrl);
      } else {
        MetadataRoutingPolicy.validateUrl(canonicalUrl);
      }
    } catch (ssrfErr: any) {
      this.logger.warn(
        `SSRF rejection for URL "${canonicalUrl}": ${ssrfErr?.message}`,
      );
      return {
        url: canonicalUrl,
        isPdf: false,
        title: slugHint.title,
        filename: slugHint.filename,
        confidence: 0.5,
      };
    }

    // 2. Fetch the URL with standard academic User-Agent
    let response: Response;
    try {
      response = await fetch(canonicalUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (Academic Client; mailto:contact@flux.academic)',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(14000),
        redirect: 'follow',
      });
    } catch (fetchErr: any) {
      this.logger.warn(
        `Failed to fetch URL "${canonicalUrl}": ${fetchErr?.message}`,
      );
      return {
        url: canonicalUrl,
        isPdf: false,
        title: slugHint.title,
        filename: slugHint.filename,
        confidence: 0.5,
      };
    }

    if (!response.ok) {
      this.logger.warn(
        `HTTP ${response.status} when fetching URL "${canonicalUrl}"`,
      );
      return {
        url: canonicalUrl,
        isPdf: false,
        title: slugHint.title,
        filename: slugHint.filename,
        confidence: 0.5,
      };
    }

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    const isPdfContent =
      contentType.includes('application/pdf') ||
      canonicalUrl.toLowerCase().endsWith('.pdf') ||
      new URL(canonicalUrl).pathname.toLowerCase().endsWith('.pdf');

    // ── Branch A: Direct PDF URL Ingestion ──────────────────────────────────
    if (isPdfContent) {
      try {
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        // Verify PDF magic bytes '%PDF'
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

          // Store PDF via StoragePort if available
          if (this.storagePort) {
            try {
              const uploadRes = await this.storagePort.uploadFile({
                userId: options?.userId || 'system',
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

          // Extract metadata via PdfProvider
          let pdfExtracted: any = {};
          if (this.pdf) {
            try {
              const doc = await this.pdf.extractDocumentFromBuffer(buffer, {
                headerOnly: true,
              });
              pdfExtracted = doc?.metadata || {};
            } catch (pdfErr: any) {
              this.logger.warn(
                `PdfProvider extraction failed: ${pdfErr?.message}`,
              );
            }
          }

          // Fast-path DOI sniffing directly from PDF binary buffer (first 64KB)
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

          // Sniff arXiv ID
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

    // ── Branch B: HTML Webpage Ingestion ────────────────────────────────────
    try {
      const htmlText = await response.text();
      const parsedHtml = this.extractHtmlMetadata(htmlText, canonicalUrl);

      const resolvedTitle = parsedHtml.title || slugHint.title;
      return {
        url: canonicalUrl,
        isPdf: false,
        filename: slugHint.filename,
        title: resolvedTitle,
        authors: parsedHtml.authors,
        creators: parsedHtml.creators,
        doi: parsedHtml.doi,
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
        confidence:
          parsedHtml.doi || parsedHtml.arxivId || parsedHtml.pmid
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
        confidence: 0.5,
      };
    }
  }

  /**
   * Extracts academic metadata from HTML source via Highwire Press, Dublin Core,
   * OpenGraph, and title tags.
   */
  extractHtmlMetadata(
    html: string,
    pageUrl: string,
  ): Partial<ScrapedUrlResult> {
    const metaTags = this.parseMetaTags(html);
    const result: Partial<ScrapedUrlResult> = {};

    // 1. Title
    const titleCandidates = [
      metaTags['citation_title'],
      metaTags['dc.title'],
      metaTags['dc:title'],
      metaTags['og:title'],
      metaTags['twitter:title'],
    ].filter(Boolean);

    let rawTitle = titleCandidates[0];
    if (!rawTitle) {
      // Fall back to <title> tag
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTagMatch && titleTagMatch[1]) {
        let cleanTag = decodeHtmlEntities(titleTagMatch[1]).trim();
        // Remove common site suffixes
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
      result.title = normalizeAcademicTitleCase(
        cleanBibliographicText(rawTitle) || rawTitle,
      );
    }

    // 2. Authors (Highwire Press supports multiple citation_author meta tags)
    const authors = this.extractAllMetaValues(html, [
      'citation_author',
      'dc.creator',
      'dc:creator',
    ]);
    if (authors.length > 0) {
      result.authors = authors;
      result.creators = authors.map((authStr, idx) => {
        const parsed = parseCreatorString(authStr, idx);
        return {
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fullName: parsed.fullName,
          creatorType: 'author',
        };
      });
    }

    // 3. Identifiers: DOI, arXiv, PMID
    const rawDoi =
      metaTags['citation_doi'] ||
      metaTags['dc.identifier'] ||
      metaTags['dc:identifier'];
    if (rawDoi) {
      result.doi = normalizeDoi(rawDoi);
    }
    if (!result.doi) {
      // Sniff embedded DOI from HTML
      const embeddedDoiMatch = html.match(
        /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)\b/i,
      );
      if (embeddedDoiMatch && !embeddedDoiMatch[1].includes('schema.org')) {
        result.doi = normalizeDoi(embeddedDoiMatch[1]);
      }
    }

    const rawArxiv = metaTags['citation_arxiv_id'];
    if (rawArxiv) {
      result.arxivId = normalizeArxivId(rawArxiv);
    }

    const rawPmid = metaTags['citation_pmid'];
    if (rawPmid) {
      result.pmid = normalizePmid(rawPmid);
    }

    // 4. Dates & Year
    const rawDate =
      metaTags['citation_publication_date'] ||
      metaTags['citation_date'] ||
      metaTags['dc.date'] ||
      metaTags['dc:date'];
    if (rawDate) {
      result.publicationDate = rawDate.trim();
      result.year = extractYearFromDate(rawDate);
    }

    // 5. Venue / Publication Title
    const venue =
      metaTags['citation_journal_title'] ||
      metaTags['citation_conference_title'] ||
      metaTags['citation_series_title'];
    if (venue) {
      result.publicationTitle = cleanBibliographicText(venue);
      result.journal = result.publicationTitle;
    }

    // 6. Publisher
    const pub = metaTags['citation_publisher'] || metaTags['dc.publisher'];
    if (pub) {
      result.publisher = cleanBibliographicText(pub);
    }

    // 7. PDF URL
    const pdfUrl =
      metaTags['citation_pdf_url'] || metaTags['citation_fulltext_html_url'];
    if (pdfUrl) {
      try {
        result.pdfUrl = new URL(pdfUrl, pageUrl).toString();
      } catch {
        result.pdfUrl = pdfUrl;
      }
    }

    // 8. Abstract
    const rawAbstract =
      metaTags['citation_abstract'] ||
      metaTags['og:description'] ||
      metaTags['description'];
    if (rawAbstract) {
      result.abstract = cleanAbstractText(rawAbstract);
    }

    // 9. Keywords
    const rawKeywords = metaTags['citation_keywords'] || metaTags['keywords'];
    if (rawKeywords) {
      result.keywords = rawKeywords
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean);
    }

    return result;
  }

  private parseMetaTags(html: string): Record<string, string> {
    const metaTags: Record<string, string> = {};
    const metaRegex =
      /<meta\s+[^>]*(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = metaRegex.exec(html)) !== null) {
      const key = match[1].trim().toLowerCase();
      const val = decodeHtmlEntities(match[2].trim());
      if (key && val && !metaTags[key]) {
        metaTags[key] = val;
      }
    }

    // Handle reverse attribute order: content="..." name="..."
    const reverseMetaRegex =
      /<meta\s+[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']([^"']+)["'][^>]*>/gi;
    while ((match = reverseMetaRegex.exec(html)) !== null) {
      const key = match[2].trim().toLowerCase();
      const val = decodeHtmlEntities(match[1].trim());
      if (key && val && !metaTags[key]) {
        metaTags[key] = val;
      }
    }

    return metaTags;
  }

  private extractAllMetaValues(html: string, targetKeys: string[]): string[] {
    const targets = new Set(targetKeys.map((k) => k.toLowerCase()));
    const values: string[] = [];

    const metaRegex =
      /<meta\s+[^>]*(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = metaRegex.exec(html)) !== null) {
      const key = match[1].trim().toLowerCase();
      const val = decodeHtmlEntities(match[2].trim());
      if (targets.has(key) && val) {
        values.push(val);
      }
    }

    const reverseRegex =
      /<meta\s+[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']([^"']+)["'][^>]*>/gi;
    while ((match = reverseRegex.exec(html)) !== null) {
      const key = match[2].trim().toLowerCase();
      const val = decodeHtmlEntities(match[1].trim());
      if (targets.has(key) && val) {
        values.push(val);
      }
    }

    return values;
  }
}
