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
  normalizeArxivId,
  normalizeDoi,
  cleanBibliographicText,
  cleanAbstractText,
  cleanCommentText,
  decodeHtmlEntities,
  normalizeTags,
} from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/metadata-executor.service';
import { getAcademicUserAgent } from '../../shared-kernel/core/constants/academic-client.constants';

@Injectable()
export class ArxivProvider implements MetadataProvider {
  readonly id: ProviderName = 'arXiv';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ARXIV'],
    isAuthoritative: true,
    timeoutMs: 4500,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(ArxivProvider.name);
  private readonly BASE_URL =
    process.env.ARXIV_API_URL || 'https://export.arxiv.org/api/query';

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanId = normalizeArxivId(request.query) ?? request.query.trim();
    if (!cleanId) return null;

    const url = `${this.BASE_URL}?id_list=${encodeURIComponent(cleanId)}&max_results=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': getAcademicUserAgent('Arxiv'),
        Accept: 'application/atom+xml, application/xml, text/xml',
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
        `arXiv API HTTP ${response.status} for id: ${cleanId}`,
        response.status,
        retryAfterMs,
      );
    }

    let xmlText: string;
    try {
      xmlText = await response.text();
    } catch {
      throw new ProviderFetchError(
        `Failed to read arXiv XML response for id: ${cleanId}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    return this.parseAtomXml(xmlText, cleanId);
  }

  private parseAtomXml(xml: string, cleanId: string): ProviderResult | null {
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
    if (!entryMatch) return null;

    const entry = entryMatch[1];

    if (entry.includes('<title>Error</title>')) return null;

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? cleanBibliographicText(titleMatch[1]) || 'Untitled arXiv Paper'
      : 'Untitled arXiv Paper';

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
    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/i);
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

    const keywords = normalizeTags(rawCategories);

    let doi: string | undefined;
    const doiMatchResult = entry.match(
      /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i,
    );
    if (doiMatchResult) {
      doi = normalizeDoi(doiMatchResult[1]);
    }
    if (!doi && cleanId) {
      const canonicalArxivIdentifier = cleanId.replace(/v\d+$/i, '');
      doi = `10.48550/arXiv.${canonicalArxivIdentifier}`;
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

    const extraLines = [
      `arXiv: ${canonicalArxivId}${primaryCategory ? ` [${primaryCategory}]` : ''}`,
    ];
    if (journal) extraLines.push(`Journal reference: ${journal}`);
    const extra = extraLines.join('\n');

    const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`;
    const canonicalUrl = `https://arxiv.org/abs/${cleanId}`;

    const rawVersion = createHash('md5').update(xml).digest('hex');

    const creators = authors.map((authorName, authorIndex) => ({
      orderIndex: authorIndex,
      creatorType: 'author',
      fullName: authorName,
    }));

    return {
      provider: this.id,
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
        genre: 'Preprint',
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
          ...(primaryCategory ? { primaryCategory } : {}),
          ...(rights ? { rights } : {}),
        },
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: `arxiv:${cleanId}`,
          canonicalUrl,
          confidenceScore: 0.95,
          rawSnapshotHash: rawVersion,
          isOpenAccess: true,
          openAccessPdfUrl: pdfUrl,
        },
      },
      confidence: 0.95,
      identifier: cleanId,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
