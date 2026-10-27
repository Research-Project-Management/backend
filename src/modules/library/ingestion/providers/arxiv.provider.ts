import { Injectable, Optional } from '@nestjs/common';
import {
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeArxivId,
  normalizeDoi,
  cleanBibliographicText,
  cleanAbstractText,
  cleanCommentText,
  decodeHtmlEntities,
  normalizeAcademicTags,
  parseCreatorString,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
} from '@/modules/library/core';
import { getAcademicUserAgent } from '@/modules/library/core/constants/academic-client.constants';
import { AbstractAcademicProvider } from './abstract-academic.provider';

@Injectable()
export class ArxivProvider extends AbstractAcademicProvider {
  readonly id: ProviderName = 'arXiv';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ARXIV'],
    isAuthoritative: true,
    timeoutMs: 4500,
    maxConcurrency: 2,
  };

  constructor(
    @Optional() httpClient?: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get baseUrl(): string {
    return (
      this.configService?.providers.arxivBaseUrl ??
      libraryConfig().providers.arxivBaseUrl
    );
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanId = normalizeArxivId(request.query) ?? request.query.trim();
    if (!cleanId) return null;

    const url = `${this.baseUrl}?id_list=${encodeURIComponent(cleanId)}&max_results=1`;

    const headers = {
      'User-Agent': getAcademicUserAgent('Arxiv'),
      Accept: 'application/atom+xml, application/xml, text/xml',
    };

    const xmlText = await this.fetchTextWithResilience(
      url,
      signal,
      headers,
      `id: ${cleanId}`,
    );
    if (!xmlText) return null;

    return this.parseAtomXml(xmlText, cleanId);
  }

  private parseAtomXml(xml: string, cleanId: string): ProviderResult | null {
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
    if (!entryMatch) return null;

    const entry = entryMatch[1];

    if (entry.includes('<title>Error</title>')) return null;

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? cleanBibliographicText(titleMatch[1]) || undefined
      : undefined;

    const authors: string[] = [];
    const authorMatches = entry.matchAll(
      /<author>\s*<name>([\s\S]*?)<\/name>/gi,
    );
    for (const match of authorMatches) {
      if (match[1]) {
        const cleanName = decodeHtmlEntities(match[1].trim());
        if (cleanName) {
          authors.push(cleanName);
        }
      }
    }

    let year: number | null = null;
    let publicationDate: string | undefined;
    const publishedMatch =
      entry.match(/<published>([\s\S]*?)<\/published>/i) ||
      entry.match(/<updated>([\s\S]*?)<\/updated>/i);
    if (publishedMatch) {
      const rawPublished = publishedMatch[1].trim();
      const dateOnly = rawPublished.match(/^(\d{4}-\d{2}-\d{2})/);
      publicationDate = dateOnly ? dateOnly[1] : rawPublished;
      const yearMatch = publicationDate.match(/^(\d{4})/);
      if (yearMatch) year = Number(yearMatch[1]);
    }

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/i);
    const abstract = summaryMatch
      ? cleanAbstractText(summaryMatch[1])
      : undefined;

    const rawCategories = Array.from(
      entry.matchAll(/<category[^>]*term=["']([^"']+)["'][^>]*>/gi),
      (match) => decodeHtmlEntities(match[1].trim()),
    ).filter(Boolean);

    const primaryCatMatch = entry.match(
      /<arxiv:primary_category[^>]*term=["']([^"']+)["'][^>]*>/i,
    );
    const primaryCategory = primaryCatMatch
      ? decodeHtmlEntities(primaryCatMatch[1].trim())
      : undefined;

    const keywords = normalizeAcademicTags(rawCategories);

    const canonicalArxivIdentifier = cleanId.replace(/v\d+$/i, '');
    const doi = cleanId ? `10.48550/arXiv.${canonicalArxivIdentifier}` : undefined;
    let publishedDoi: string | undefined;
    const doiMatchResult = entry.match(
      /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i,
    );
    if (doiMatchResult) {
      publishedDoi = normalizeDoi(doiMatchResult[1]);
    }

    let journal: string | undefined;
    const journalMatch = entry.match(
      /<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/i,
    );
    if (journalMatch) {
      journal = cleanBibliographicText(journalMatch[1]);
    }

    let comment: string | undefined;
    const commentMatch = entry.match(
      /<arxiv:comment[^>]*>([\s\S]*?)<\/arxiv:comment>/i,
    );
    if (commentMatch) {
      comment = cleanCommentText(commentMatch[1]);
    }

    let rights: string | undefined;
    const licenseLinkMatch =
      entry.match(
        /<link[^>]*title=["']license["'][^>]*href=["']([^"']+)["'][^>]*>/i,
      ) ||
      entry.match(
        /<link[^>]*href=["']([^"']+)["'][^>]*title=["']license["'][^>]*>/i,
      );
    if (licenseLinkMatch && licenseLinkMatch[1]) {
      const rawLicense = licenseLinkMatch[1].trim();
      if (rawLicense.includes('licenses/by/4.0')) {
        rights = 'CC BY 4.0';
      } else if (rawLicense.includes('licenses/by-sa/4.0')) {
        rights = 'CC BY-SA 4.0';
      } else if (rawLicense.includes('licenses/by-nc-sa/4.0')) {
        rights = 'CC BY-NC-SA 4.0';
      } else if (rawLicense.includes('licenses/by-nc-nd/4.0')) {
        rights = 'CC BY-NC-ND 4.0';
      } else if (rawLicense.includes('nonexclusive-distrib')) {
        rights = 'arXiv.org perpetual non-exclusive license';
      } else if (rawLicense.includes('publicdomain/zero/1.0')) {
        rights = 'CC0 1.0';
      } else {
        rights = rawLicense;
      }
    }

    const canonicalArxivId = cleanId.replace(/v\d+$/i, '');
    const versionMatch = cleanId.match(/v(\d+)$/i);
    const versionNumber = versionMatch ? `v${versionMatch[1]}` : undefined;

    // Legacy archive IDs containing '/' do not append [primaryCategory]
    const arxivExtraLine = canonicalArxivId.includes('/')
      ? `arXiv:${canonicalArxivId}`
      : `arXiv:${canonicalArxivId}${primaryCategory ? ` [${primaryCategory}]` : ''}`;
    const extraLines = [arxivExtraLine];
    if (versionMatch) {
      extraLines.push(`version: ${versionMatch[1]}`);
    }
    if (journal) extraLines.push(`Journal reference: ${journal}`);
    if (publishedDoi) extraLines.push(`Related DOI: ${publishedDoi}`);
    const extra = extraLines.join('\n');

    const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`;
    const canonicalUrl = `https://arxiv.org/abs/${cleanId}`;

    const creators = authors.map((authorName, authorIndex) =>
      parseCreatorString(authorName, authorIndex, 'author'),
    );

    return this.buildProviderResult({
      identifier: cleanId,
      confidenceScore: 0.95,
      rawPayload: xml,
      retrievalMethod: 'api',
      sourceUrl: canonicalUrl,
      canonicalId: `arxiv:${cleanId}`,
      isOpenAccess: true,
      openAccessPdfUrl: pdfUrl,
      metadata: {
        arxivId: cleanId,
        doi,
        title,
        authors,
        creators,
        year,
        publicationDate,
        date: publicationDate,
        publisher: 'arXiv',
        publicationTitle: journal,
        genre: 'Preprint',
        versionNumber,
        abstract,
        archive: 'arXiv',
        repository: 'arXiv',
        archiveId: `arXiv:${canonicalArxivId}`,
        libraryCatalog: 'arXiv.org',
        callNumber: undefined,
        rights,
        license: rights,
        extra,
        notes: comment
          ? [{ content: `Comment: ${comment}`, source: 'arXiv' }]
          : undefined,
        keywords: keywords.length > 0 ? keywords : undefined,
        tags: keywords.length > 0 ? keywords : undefined,
        itemType: 'preprint',
        url: canonicalUrl,
        openAccessPdfUrl: pdfUrl,
        extraFields: {
          repository: 'arXiv',
          archiveId: cleanId,
          ...(versionNumber ? { versionNumber } : {}),
          ...(primaryCategory ? { primaryCategory } : {}),
          ...(rights ? { rights } : {}),
          ...(journal ? { journalRef: journal } : {}),
          ...(publishedDoi ? { publishedDoi } : {}),
        },
      },
    });
  }
}
