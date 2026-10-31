import {
  ItemMetadata,
  isInstitutionName,
  isNoiseAuthorName,
} from '@/modules/library/core';
import { isValidIsbnChecksum } from '@/modules/library/core/domain/identifier.domain';
import { QualityScoreBreakdown } from '@/modules/library/extraction/types/extraction.types';

export interface EvaluationResult {
  breakdown: QualityScoreBreakdown;
  isSelfSufficient: boolean;
  missingFields: string[];
}

/**
 * Deterministic Decision Gate evaluating whether extracted local metadata
 * is sufficiently authoritative to bypass external APIs and heavy ML sidecars.
 */
export class MetadataQualityGate {
  public static readonly SELF_SUFFICIENCY_THRESHOLD = 0.85;

  private static readonly WEIGHT_TITLE = 0.3;
  private static readonly WEIGHT_AUTHOR = 0.25;
  private static readonly WEIGHT_IDENTIFIER = 0.2;
  private static readonly WEIGHT_YEAR = 0.15;
  private static readonly WEIGHT_VENUE = 0.1;

  private static readonly GARBAGE_TITLE_REGEX =
    /^(untitled|document|microsoft word|manuscript|proceedings of the|submitted to|accepted at|journal pre-proof|accepted manuscript|author guidelines|camera-ready|supplementary material|powerpoint presentation|latex template|https?:\/\/|\d{4}\.\d{4,5})/i;

  private static evaluateTitle(title?: string): number {
    if (!title || typeof title !== 'string') return 0.0;
    const clean = title.trim();
    if (clean.length < 8) return 0.0;
    if (clean.endsWith('.pdf') || clean.endsWith('.eps')) return 0.0;
    if (this.GARBAGE_TITLE_REGEX.test(clean)) return 0.0;
    if (clean.length >= 15) return 1.0;
    return 0.7;
  }

  private static evaluateAuthors(
    authors?: string[],
    creators?: Array<
      | { fullName?: string | null; name?: string | null }
      | string
      | Record<string, unknown>
    >,
  ): number {
    const list =
      authors && authors.length > 0
        ? authors
        : creators && creators.length > 0
          ? creators.map((c) => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object') {
                const rec = c as Record<string, unknown>;
                return (
                  (typeof rec.fullName === 'string' ? rec.fullName : null) ||
                  (typeof rec.name === 'string' ? rec.name : null) ||
                  undefined
                );
              }
              return undefined;
            })
          : [];

    if (list.length === 0) return 0.0;

    const validPersons = list.filter((name) => {
      if (!name || typeof name !== 'string') return false;
      const t = name.trim();
      if (t.length < 2 || /^\d+$/.test(t)) return false;
      if (
        /^(admin|administrator|user|owner|author|default|root|guest|unknown|test)$/i.test(
          t,
        )
      ) {
        return false;
      }
      if (isInstitutionName(t) || isNoiseAuthorName(t)) return false;
      return true;
    });

    if (validPersons.length >= 1) return 1.0;
    return 0.3;
  }

  private static evaluateIdentifier(
    doi?: string,
    arxivId?: string,
    pmid?: string,
    isbn?: string,
  ): number {
    if (doi && /^10\.\d{4,9}\/\S+$/i.test(doi)) return 1.0;
    if (arxivId && /^\d{4}\.\d{4,5}/.test(arxivId)) return 1.0;
    if (pmid && /^\d{7,9}$/.test(pmid)) return 1.0;
    if (isbn && isValidIsbnChecksum(isbn)) return 1.0;
    return 0.0;
  }

  private static evaluateYear(year?: number | null): number {
    if (!year || typeof year !== 'number') return 0.0;
    const currentYear = new Date().getFullYear();
    if (year >= 1900 && year <= currentYear + 2) {
      return 1.0;
    }
    return 0.0;
  }

  private static evaluateVenue(
    journal?: string,
    publisher?: string,
    conferenceName?: string,
  ): number {
    if (
      (journal && journal.trim().length > 2) ||
      (conferenceName && conferenceName.trim().length > 2)
    ) {
      return 1.0;
    }
    if (publisher && publisher.trim().length > 2) {
      return 0.8;
    }
    return 0.0;
  }

  public static evaluate(metadata: ItemMetadata): EvaluationResult {
    const dimensions = [
      {
        key: 'titleScore' as const,
        weight: this.WEIGHT_TITLE,
        minValid: 0.7,
        missingField: 'title',
        score: this.evaluateTitle(metadata.title),
      },
      {
        key: 'authorScore' as const,
        weight: this.WEIGHT_AUTHOR,
        minValid: 0.5,
        missingField: 'authors',
        score: this.evaluateAuthors(metadata.authors, metadata.creators),
      },
      {
        key: 'identifierScore' as const,
        weight: this.WEIGHT_IDENTIFIER,
        minValid: 0.01,
        missingField: 'doi/arxivId',
        score: this.evaluateIdentifier(
          metadata.doi,
          metadata.arxivId,
          metadata.pmid,
          metadata.isbn,
        ),
      },
      {
        key: 'yearScore' as const,
        weight: this.WEIGHT_YEAR,
        minValid: 0.01,
        missingField: 'year',
        score: this.evaluateYear(metadata.year),
      },
      {
        key: 'venueScore' as const,
        weight: this.WEIGHT_VENUE,
        minValid: 0.01,
        missingField: 'journal/publisher',
        score: this.evaluateVenue(
          metadata.journal || metadata.publicationTitle,
          metadata.publisher,
          metadata.conferenceName,
        ),
      },
    ];

    let totalRaw = 0;
    const missingFields: string[] = [];
    const scoresByKey = {} as Record<
      (typeof dimensions)[number]['key'],
      number
    >;

    for (const d of dimensions) {
      totalRaw += d.weight * d.score;
      scoresByKey[d.key] = d.score;
      if (d.score < d.minValid) {
        missingFields.push(d.missingField);
      }
    }

    const totalScore = Math.round(totalRaw * 100) / 100;

    return {
      breakdown: {
        ...scoresByKey,
        totalScore,
      },
      isSelfSufficient: totalScore >= this.SELF_SUFFICIENCY_THRESHOLD,
      missingFields,
    };
  }
}
