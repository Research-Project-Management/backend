import { Injectable, Logger } from '@nestjs/common';
import { ItemMetadata } from '../types/metadata.types';
import {
  titleSimilarity,
  TITLE_MATCH_THRESHOLD,
  parseCreatorString,
} from '../../shared-kernel/utils/bibliographic.utils';

export interface PdfFingerprint {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  title?: string;
  firstAuthorSurname?: string;
  year?: number;
  firstPageText?: string;
}

export type IngestionVerificationStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'NEEDS_REVIEW'
  | 'BLOCKED'
  | 'FAILED';

export interface VerificationFieldProvenance {
  source: string;
  confidence: number;
  verified: boolean;
}

export interface VerificationResult {
  verificationScore: number; // 0.0 - 1.0
  isVerified: boolean; // score >= 0.80
  status: IngestionVerificationStatus;
  matchedSignals: string[];
  missingFields: string[];
  fieldProvenance: Record<string, VerificationFieldProvenance>;
  warnings: string[];
}

const BOT_CHALLENGE_TITLE_RE =
  /client challenge|just a moment|attention required|access denied|are you a robot|verify you are human|captcha|security check|ddos-guard|please wait|cloudflare|bot verification|request blocked|unusual traffic/i;

const BOT_CHALLENGE_HTML_RE =
  /cf-challenge|_cf_chl|challenge-platform|perimeterx|px-captcha|datadome|captcha-delivery|cf-browser-verification/i;

/**
 * Enterprise Verification and Evidence Gate implementing the Ingestion Verification Scoring Table.
 * Prevents hallucinations, WAF interstitials, and false-positive cross-pollination.
 */
@Injectable()
export class IngestionVerifierService {
  private readonly logger = new Logger(IngestionVerifierService.name);

  // Verification Scoring Weights (defined in ingestion_pipeline_design.md)
  public static readonly WEIGHT_IDENTIFIER_MATCH = 0.4;
  public static readonly WEIGHT_TITLE_MATCH = 0.3;
  public static readonly WEIGHT_AUTHOR_MATCH = 0.2;
  public static readonly WEIGHT_YEAR_MATCH = 0.1;
  public static readonly VERIFIED_THRESHOLD = 0.8;
  public static readonly REVIEW_THRESHOLD = 0.5;

  /**
   * Constructs a fast fingerprint from the raw PDF text layer and extracted metadata.
   */
  public extractFingerprint(
    metadata: ItemMetadata,
    firstPageText?: string,
  ): PdfFingerprint {
    let firstAuthorSurname: string | undefined;
    if (metadata.authors && metadata.authors.length > 0) {
      firstAuthorSurname = parseCreatorString(metadata.authors[0]).lastName ?? undefined;
    } else if (metadata.creators && metadata.creators.length > 0) {
      firstAuthorSurname = metadata.creators[0].lastName ?? undefined;
    }

    return {
      doi: metadata.doi ?? undefined,
      arxivId: metadata.arxivId ?? undefined,
      pmid: metadata.pmid ?? undefined,
      title: metadata.title ?? undefined,
      firstAuthorSurname: firstAuthorSurname?.toLowerCase().trim(),
      year: metadata.year ?? undefined,
      firstPageText: firstPageText?.slice(0, 5000),
    };
  }

  /**
   * Verifies external web-retrieved candidate metadata against the local PDF fingerprint.
   * Cross-checks identifiers, title similarity, author surname, and year.
   */
  public verifyWebCandidate(
    fingerprint: PdfFingerprint,
    candidate: ItemMetadata,
    sourceName: string = 'web',
  ): VerificationResult {
    const matchedSignals: string[] = [];
    const warnings: string[] = [];
    let score = 0.0;

    const pageText = (fingerprint.firstPageText || '').toLowerCase();

    // ── 1. Identifier Verification (+0.40) ──────────────────────────────────
    let idMatched = false;
    if (candidate.doi) {
      const cleanCandidateDoi = candidate.doi.toLowerCase().trim();
      const cleanFingerprintDoi = (fingerprint.doi || '').toLowerCase().trim();
      if (
        cleanCandidateDoi === cleanFingerprintDoi ||
        (cleanCandidateDoi && pageText.includes(cleanCandidateDoi))
      ) {
        score += IngestionVerifierService.WEIGHT_IDENTIFIER_MATCH;
        matchedSignals.push('identifier_doi_verified');
        idMatched = true;
      }
    }

    if (!idMatched && candidate.arxivId) {
      const cleanCandidateArxiv = candidate.arxivId.toLowerCase().trim();
      const cleanFingerprintArxiv = (fingerprint.arxivId || '')
        .toLowerCase()
        .trim();
      if (
        cleanCandidateArxiv === cleanFingerprintArxiv ||
        (cleanCandidateArxiv && pageText.includes(cleanCandidateArxiv))
      ) {
        score += IngestionVerifierService.WEIGHT_IDENTIFIER_MATCH;
        matchedSignals.push('identifier_arxiv_verified');
        idMatched = true;
      }
    }

    if (!idMatched && candidate.pmid && fingerprint.pmid) {
      if (candidate.pmid.trim() === fingerprint.pmid.trim()) {
        score += IngestionVerifierService.WEIGHT_IDENTIFIER_MATCH;
        matchedSignals.push('identifier_pmid_verified');
        idMatched = true;
      }
    }

    if (!idMatched && (candidate.doi || candidate.arxivId)) {
      warnings.push('candidate_identifier_not_found_in_pdf');
    }

    // ── 2. Title Verification (+0.30) ───────────────────────────────────────
    let titleVerified = false;
    if (candidate.title && fingerprint.title) {
      const sim = titleSimilarity(candidate.title, fingerprint.title);
      if (sim >= TITLE_MATCH_THRESHOLD) {
        // >= 0.85
        score += IngestionVerifierService.WEIGHT_TITLE_MATCH;
        matchedSignals.push(`title_dice_exact (${(sim * 100).toFixed(0)}%)`);
        titleVerified = true;
      } else if (sim >= 0.7) {
        score += IngestionVerifierService.WEIGHT_TITLE_MATCH * 0.5;
        matchedSignals.push(`title_dice_partial (${(sim * 100).toFixed(0)}%)`);
        warnings.push('title_similarity_below_authoritative_threshold');
      } else {
        warnings.push(
          `title_similarity_mismatch (${(sim * 100).toFixed(0)}%)`,
        );
      }
    } else if (candidate.title && pageText.length > 50) {
      const sim = titleSimilarity(candidate.title, pageText.slice(0, 1000));
      if (sim >= 0.7) {
        score += IngestionVerifierService.WEIGHT_TITLE_MATCH * 0.7;
        matchedSignals.push('title_found_in_pdf_page1');
        titleVerified = true;
      }
    }

    // ── 3. First Author Surname Match (+0.20) ───────────────────────────────
    let authorVerified = false;
    let candidateAuthorSurname: string | undefined;
    if (candidate.authors && candidate.authors.length > 0) {
      candidateAuthorSurname = parseCreatorString(
        candidate.authors[0],
      ).lastName;
    } else if (candidate.creators && candidate.creators.length > 0) {
      candidateAuthorSurname = candidate.creators[0].lastName ?? undefined;
    }

    if (candidateAuthorSurname) {
      const cleanCandidateSurname = candidateAuthorSurname
        .toLowerCase()
        .trim();
      if (
        fingerprint.firstAuthorSurname &&
        fingerprint.firstAuthorSurname === cleanCandidateSurname
      ) {
        score += IngestionVerifierService.WEIGHT_AUTHOR_MATCH;
        matchedSignals.push('first_author_surname_matched');
        authorVerified = true;
      } else if (
        cleanCandidateSurname.length >= 3 &&
        pageText.includes(cleanCandidateSurname)
      ) {
        score += IngestionVerifierService.WEIGHT_AUTHOR_MATCH;
        matchedSignals.push('author_surname_found_in_pdf_header');
        authorVerified = true;
      } else {
        warnings.push('first_author_surname_mismatch');
      }
    }

    // ── 4. Year Match (+0.10) ───────────────────────────────────────────────
    let yearVerified = false;
    if (candidate.year && fingerprint.year) {
      const yearDiff = Math.abs(candidate.year - fingerprint.year);
      if (yearDiff <= 1) {
        score += IngestionVerifierService.WEIGHT_YEAR_MATCH;
        matchedSignals.push('publication_year_matched');
        yearVerified = true;
      } else {
        warnings.push(
          `year_divergence: candidate=${candidate.year} vs pdf=${fingerprint.year}`,
        );
      }
    }

    const verificationScore = Math.min(1.0, Math.round(score * 100) / 100);
    const isVerified =
      verificationScore >= IngestionVerifierService.VERIFIED_THRESHOLD;

    // Field-level provenance mapping
    const fieldProvenance: Record<string, VerificationFieldProvenance> = {};
    const assignProv = (
      fieldName: string,
      confidence: number,
      verified: boolean,
    ) => {
      fieldProvenance[fieldName] = {
        source: sourceName,
        confidence,
        verified,
      };
    };

    if (candidate.title)
      assignProv(
        'title',
        titleVerified ? 0.95 : 0.6,
        titleVerified || isVerified,
      );
    if (candidate.authors?.length)
      assignProv(
        'authors',
        authorVerified ? 0.95 : 0.6,
        authorVerified || isVerified,
      );
    if (candidate.doi)
      assignProv('doi', idMatched ? 1.0 : 0.7, idMatched || isVerified);
    if (candidate.arxivId)
      assignProv(
        'arxivId',
        idMatched ? 1.0 : 0.7,
        idMatched || isVerified,
      );
    if (candidate.year)
      assignProv(
        'year',
        yearVerified ? 0.95 : 0.6,
        yearVerified || isVerified,
      );
    if (candidate.journal || candidate.publicationTitle)
      assignProv('journal', isVerified ? 0.9 : 0.6, isVerified);
    if (candidate.abstract)
      assignProv('abstract', isVerified ? 0.9 : 0.6, isVerified);

    // Missing field analysis
    const missingFields: string[] = [];
    if (!candidate.title) missingFields.push('title');
    if (!candidate.authors || candidate.authors.length === 0)
      missingFields.push('authors');
    if (!candidate.doi && !candidate.arxivId)
      missingFields.push('identifier');
    if (!candidate.year) missingFields.push('year');
    if (!candidate.journal && !candidate.publicationTitle)
      missingFields.push('journal/venue');
    if (!candidate.abstract || candidate.abstract.length < 50)
      missingFields.push('abstract');

    // Status determination
    let status: IngestionVerificationStatus = 'COMPLETE';
    if (!candidate.title || verificationScore < 0.3) {
      status = 'FAILED';
    } else if (
      verificationScore < IngestionVerifierService.VERIFIED_THRESHOLD
    ) {
      status = 'NEEDS_REVIEW';
    } else if (missingFields.length > 0) {
      status = 'PARTIAL';
    } else {
      status = 'COMPLETE';
    }

    return {
      verificationScore,
      isVerified,
      status,
      matchedSignals,
      missingFields,
      fieldProvenance,
      warnings,
    };
  }

  /**
   * Evaluates a purely local in-process PDF extraction when no web search was performed.
   * Produces field provenance and status (COMPLETE / PARTIAL / NEEDS_REVIEW).
   */
  public evaluateLocalResult(
    metadata: ItemMetadata,
    engineUsed: string = 'LOCAL_IN_PROCESS',
    qualityScore: number = 0.85,
  ): VerificationResult {
    const missingFields: string[] = [];
    const fieldProvenance: Record<string, VerificationFieldProvenance> = {};
    const warnings: string[] = [];

    const assignProv = (fieldName: string, conf: number, verified: boolean) => {
      fieldProvenance[fieldName] = {
        source: engineUsed,
        confidence: conf,
        verified,
      };
    };

    const hasCredibleTitle =
      Boolean(metadata.title) &&
      metadata.title !== 'Uploaded Document' &&
      !BOT_CHALLENGE_TITLE_RE.test(metadata.title!);

    if (hasCredibleTitle) {
      assignProv('title', 0.9, true);
    } else {
      missingFields.push('title');
    }

    if (metadata.authors && metadata.authors.length > 0) {
      assignProv('authors', 0.85, true);
    } else {
      missingFields.push('authors');
    }

    if (metadata.doi || metadata.arxivId) {
      if (metadata.doi) assignProv('doi', 0.95, true);
      if (metadata.arxivId) assignProv('arxivId', 0.95, true);
    } else {
      missingFields.push('identifier');
    }

    if (
      metadata.year &&
      metadata.year >= 1900 &&
      metadata.year <= new Date().getFullYear() + 1
    ) {
      assignProv('year', 0.9, true);
    } else {
      missingFields.push('year');
    }

    if (metadata.journal || metadata.publicationTitle || metadata.conferenceName) {
      assignProv('journal', 0.8, true);
    } else {
      missingFields.push('journal/venue');
    }

    if (metadata.abstract && metadata.abstract.length >= 50) {
      assignProv('abstract', 0.85, true);
    } else {
      missingFields.push('abstract');
    }

    let status: IngestionVerificationStatus = 'COMPLETE';
    if (!hasCredibleTitle) {
      status = 'FAILED';
      warnings.push('missing_or_corrupt_title');
    } else if (qualityScore < 0.5) {
      status = 'NEEDS_REVIEW';
      warnings.push('low_extraction_quality_score');
    } else if (missingFields.length > 0) {
      status = 'PARTIAL';
    } else {
      status = 'COMPLETE';
    }

    return {
      verificationScore: qualityScore,
      isVerified: qualityScore >= 0.8,
      status,
      matchedSignals: ['local_heuristic_verified'],
      missingFields,
      fieldProvenance,
      warnings,
    };
  }

  /**
   * Detects whether an ingestion response was blocked by an upstream bot challenge (Cloudflare, Akamai).
   */
  public detectBlockedStatus(
    url: string,
    htmlContent?: string,
    httpStatus?: number,
  ): { isBlocked: boolean; wafKind?: string; promptUploadPdf: boolean } {
    if (httpStatus === 403 || httpStatus === 429) {
      return {
        isBlocked: true,
        wafKind: httpStatus === 403 ? 'HTTP_403_FORBIDDEN' : 'RATE_LIMITED',
        promptUploadPdf: true,
      };
    }

    if (htmlContent) {
      const pageTitleMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = pageTitleMatch ? pageTitleMatch[1].trim() : '';

      if (title && BOT_CHALLENGE_TITLE_RE.test(title)) {
        return {
          isBlocked: true,
          wafKind: 'BOT_CHALLENGE_TITLE',
          promptUploadPdf: true,
        };
      }

      if (BOT_CHALLENGE_HTML_RE.test(htmlContent)) {
        return {
          isBlocked: true,
          wafKind: 'WAF_INTERSTITIAL_BODY',
          promptUploadPdf: true,
        };
      }
    }

    return { isBlocked: false, promptUploadPdf: false };
  }
}
