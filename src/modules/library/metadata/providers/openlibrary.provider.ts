import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

import { UnifiedAcademicMetadata } from '../types/metadata.types';
import {
  normalizeIsbn,
  validateAcademicMetadata,
} from '../utils/metadata.util';

import { createHash } from 'crypto';

@Injectable()
export class OpenlibraryProvider {
  private readonly logger = new Logger(OpenlibraryProvider.name);
  private readonly BASE_URL = 'https://openlibrary.org/api/books';

  /**
   * Fetch book metadata by ISBN-10 or ISBN-13 from OpenLibrary (Internet Archive)
   */
  async fetchByIsbn(isbn: string): Promise<UnifiedAcademicMetadata | null> {
    if (!isbn) return null;

    const cleanIsbn = normalizeIsbn(isbn);
    if (!cleanIsbn) return null;

    const bibKey = `ISBN:${cleanIsbn}`;
    const url = `${this.BASE_URL}?bibkeys=${encodeURIComponent(bibKey)}&format=json&jscmd=data`;

    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent':
            'ResearchManagementPlatform/1.0 (mailto:admin@researchmanagement.local; academic-research-bot)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) {
      this.logger.warn(`OpenLibrary fetch failed for ISBN: ${cleanIsbn}`);
      return null;
    }

    const jsonResult = await tryCatch(responseResult.value.json());
    if (!jsonResult.ok || !jsonResult.value?.[bibKey]) {
      return null;
    }

    const item = jsonResult.value[bibKey];
    return this.transformPayload(item, cleanIsbn);
  }

  transformPayload(item: any, cleanIsbn: string): UnifiedAcademicMetadata {
    const title = item.title || 'Untitled Book';

    const authors: string[] = Array.isArray(item.authors)
      ? item.authors.map((a: any) => a.name).filter(Boolean)
      : [];

    let year: number | null = null;
    if (item.publish_date) {
      const match = item.publish_date.match(/(\d{4})/);
      if (match) year = Number(match[1]);
    }

    const publisher =
      Array.isArray(item.publishers) && item.publishers[0]?.name
        ? item.publishers[0].name
        : undefined;

    const pages = item.number_of_pages
      ? String(item.number_of_pages)
      : undefined;
    const rawSnapshotHash = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const result: UnifiedAcademicMetadata = {
      title,
      authors,
      year,
      isbn: cleanIsbn,
      publisher,
      pages,
      itemType: 'book',
      url: item.url || `https://openlibrary.org/isbn/${cleanIsbn}`,
      provenance: {
        originProvider: 'OpenLibrary',
        resolvedAt: new Date().toISOString(),
        canonicalId: `isbn:${cleanIsbn}`,
        canonicalUrl: item.url || `https://openlibrary.org/isbn/${cleanIsbn}`,
        confidenceScore: 1.0,
        rawSnapshotHash,
        isOpenAccess: false,
      },
    };

    return validateAcademicMetadata(result) || result;
  }
}
