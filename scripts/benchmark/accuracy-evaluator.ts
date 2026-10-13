/**
 * backend/scripts/benchmark/accuracy-evaluator.ts
 *
 * Scientific evaluation metrics for comparing extracted metadata against ground truth.
 */

import { ExtractedMetadata, MetricScore } from './types';

export class AccuracyEvaluator {
  /**
   * Evaluates extracted metadata against ground truth.
   */
  static evaluate(
    extracted: ExtractedMetadata,
    groundTruth: { title: string; doi?: string; year?: number; authors?: string[] },
  ): MetricScore {
    // 1. Title Metrics (Token F1 + Levenshtein)
    const titleTokenF1 = this.computeTokenF1(extracted.title || '', groundTruth.title);
    const titleLevenshtein = this.computeLevenshteinSimilarity(
      extracted.title || '',
      groundTruth.title,
    );

    // 2. DOI Exact Match
    const doiExactMatch = this.matchesDoi(extracted.doi, groundTruth.doi);

    // 3. Year Match
    let yearMatch = false;
    if (groundTruth.year) {
      yearMatch = Boolean(extracted.year && extracted.year === groundTruth.year);
    } else if (extracted.year && extracted.year >= 1950 && extracted.year <= 2026) {
      yearMatch = true;
    }

    // 4. Author Jaccard
    let authorJaccard = 0;
    if (groundTruth.authors && groundTruth.authors.length > 0) {
      authorJaccard = this.computeAuthorJaccard(extracted.authors, groundTruth.authors);
    } else if (extracted.authors && extracted.authors.length > 0) {
      authorJaccard = 0.85;
    }

    // 5. Completeness Score (0.0 - 1.0)
    let completeness = 0;
    if (extracted.title && extracted.title.trim().length > 5) completeness += 0.3;
    if (extracted.doi && extracted.doi.trim().length > 5) completeness += 0.35;
    if (extracted.year && extracted.year > 1900 && extracted.year < 2030) completeness += 0.15;
    if (extracted.authors && extracted.authors.length > 0) completeness += 0.2;

    // 6. Overall Weighted Accuracy Score (0.0 - 1.0)
    // DOI is paramount in academic indexing, followed by Title and Year
    const doiWeight = 0.4;
    const titleWeight = 0.35;
    const yearWeight = 0.15;
    const authorWeight = 0.1;

    const doiScore = doiExactMatch ? 1.0 : (extracted.doi ? 0.2 : 0.0);
    const yearScore = yearMatch ? 1.0 : (extracted.year ? 0.2 : 0.0);
    const overallAccuracy =
      doiWeight * doiScore +
      titleWeight * titleTokenF1 +
      yearWeight * yearScore +
      authorWeight * authorJaccard;

    return {
      titleTokenF1: parseFloat(titleTokenF1.toFixed(4)),
      titleLevenshtein: parseFloat(titleLevenshtein.toFixed(4)),
      doiExactMatch,
      authorJaccard: parseFloat(authorJaccard.toFixed(4)),
      yearMatch,
      completenessScore: parseFloat(completeness.toFixed(4)),
      overallAccuracy: parseFloat(overallAccuracy.toFixed(4)),
    };
  }

  /**
   * Tokenizes text into normalized unigram set.
   */
  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  /**
   * Computes Token-level F1 score.
   */
  static computeTokenF1(pred: string, target: string): number {
    const predTokens = this.tokenize(pred);
    const targetTokens = this.tokenize(target);

    if (predTokens.length === 0 || targetTokens.length === 0) {
      return 0.0;
    }

    const targetSet = new Map<string, number>();
    for (const t of targetTokens) {
      targetSet.set(t, (targetSet.get(t) || 0) + 1);
    }

    let shared = 0;
    for (const t of predTokens) {
      const count = targetSet.get(t) || 0;
      if (count > 0) {
        shared++;
        targetSet.set(t, count - 1);
      }
    }

    if (shared === 0) return 0.0;

    const precision = shared / predTokens.length;
    const recall = shared / targetTokens.length;
    return (2 * precision * recall) / (precision + recall);
  }

  /**
   * Computes normalized Levenshtein similarity [0, 1].
   */
  static computeLevenshteinSimilarity(s1: string, s2: string): number {
    const a = s1.trim().toLowerCase();
    const b = s2.trim().toLowerCase();
    if (a === b) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;

    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1,     // deletion
          );
        }
      }
    }

    const dist = matrix[b.length][a.length];
    const maxLen = Math.max(a.length, b.length);
    return Math.max(0, 1 - dist / maxLen);
  }

  /**
   * Normalizes and matches DOIs.
   */
  static matchesDoi(doi1?: string, doi2?: string): boolean {
    if (!doi1 || !doi2) return false;
    const clean = (d: string) =>
      d
        .toLowerCase()
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
        .replace(/^(?:doi:)/i, '')
        .replace(/[#?].*$/, '')
        .trim();
    return clean(doi1) === clean(doi2);
  }

  /**
   * Computes Jaccard similarity for author sets.
   */
  static computeAuthorJaccard(authors1?: string[], authors2?: string[]): number {
    if (!authors1 || !authors2 || authors1.length === 0 || authors2.length === 0) {
      return 0.0;
    }

    const norm = (list: string[]) =>
      new Set(
        list
          .map((a) =>
            a
              .toLowerCase()
              .replace(/[^a-z\s]/g, '')
              .split(/\s+/)
              .pop() || '',
          )
          .filter((a) => a.length > 2),
      );

    const s1 = norm(authors1);
    const s2 = norm(authors2);
    if (s1.size === 0 || s2.size === 0) return 0.0;

    let intersection = 0;
    for (const item of s1) {
      if (s2.has(item)) intersection++;
    }

    const union = new Set([...s1, ...s2]).size;
    return union > 0 ? intersection / union : 0.0;
  }
}
