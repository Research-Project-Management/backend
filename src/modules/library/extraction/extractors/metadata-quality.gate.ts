import { Injectable } from '@nestjs/common';
import { ItemMetadata } from '../../shared-kernel';
import { QualityScoreBreakdown } from '../types/trusted-extraction.types';
import { isInstitutionName } from '../../shared-kernel/utils/bibliographic.utils';

export interface EvaluationResult {
  breakdown: QualityScoreBreakdown;
  isSelfSufficient: boolean;
  missingFields: string[];
}

/**
 * Deterministic Decision Gate evaluating whether extracted local metadata
 * is sufficiently authoritative to bypass external APIs and heavy ML sidecars.
 */
@Injectable()
export class MetadataQualityGate {
  public static readonly SELF_SUFFICIENCY_THRESHOLD = 0.85;

  private static readonly WEIGHT_TITLE = 0.3;
  private static readonly WEIGHT_AUTHOR = 0.25;
  private static readonly WEIGHT_IDENTIFIER = 0.2;
  private static readonly WEIGHT_YEAR = 0.15;
  private static readonly WEIGHT_VENUE = 0.1;

  private static readonly GARBAGE_TITLE_REGEX =
    /^(untitled|document|microsoft word|manuscript|proceedings of the|submitted to|accepted at|\d{4}\.\d{4,5})/i;

  private static evaluateTitle(title?: string): number {
    if (!title || typeof title !== 'string') return 0.0;
    const clean = title.trim();
    if (clean.length < 8) return 0.0;
    if (clean.endsWith('.pdf') || clean.endsWith('.eps')) return 0.0;
    if (this.GARBAGE_TITLE_REGEX.test(clean)) return 0.0;
    if (clean.length >= 15) return 1.0;
    return 0.7;
  }

  private static evaluateAuthors(authors?: string[], creators?: any[]): number {
    const list =
      authors && authors.length > 0
        ? authors
        : creators && creators.length > 0
          ? creators.map((c) =>
              typeof c === 'string' ? c : c.fullName || c.name,
            )
          : [];

    if (list.length === 0) return 0.0;

    const validPersons = list.filter((name) => {
      if (!name || typeof name !== 'string') return false;
      const t = name.trim();
      if (t.length < 2 || /^\d+$/.test(t)) return false;
      if (isInstitutionName(t) && !t.includes(',')) return false;
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
    if (isbn && (isbn.length === 10 || isbn.length === 13)) return 1.0;
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
    const titleScore = this.evaluateTitle(metadata.title);
    const authorScore = this.evaluateAuthors(
      metadata.authors,
      metadata.creators,
    );
    const identifierScore = this.evaluateIdentifier(
      metadata.doi,
      metadata.arxivId,
      metadata.pmid,
      metadata.isbn,
    );
    const yearScore = this.evaluateYear(metadata.year);
    const venueScore = this.evaluateVenue(
      metadata.journal || metadata.publicationTitle,
      metadata.publisher,
      metadata.conferenceName,
    );

    const totalRaw =
      titleScore * this.WEIGHT_TITLE +
      authorScore * this.WEIGHT_AUTHOR +
      identifierScore * this.WEIGHT_IDENTIFIER +
      yearScore * this.WEIGHT_YEAR +
      venueScore * this.WEIGHT_VENUE;

    const totalScore = Math.round(totalRaw * 100) / 100;
    const isSelfSufficient = totalScore >= this.SELF_SUFFICIENCY_THRESHOLD;

    const missingFields: string[] = [];
    if (titleScore < 0.7) missingFields.push('title');
    if (authorScore < 0.5) missingFields.push('authors');
    if (identifierScore === 0) missingFields.push('doi/arxivId');
    if (yearScore === 0) missingFields.push('year');
    if (venueScore === 0) missingFields.push('journal/publisher');

    const breakdown: QualityScoreBreakdown = {
      titleScore,
      authorScore,
      identifierScore,
      yearScore,
      venueScore,
      totalScore,
    };

    return {
      breakdown,
      isSelfSufficient,
      missingFields,
    };
  }
}
