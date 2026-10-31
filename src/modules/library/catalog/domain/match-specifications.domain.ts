import { Prisma } from '@prisma/client';
import {
  ISpecification,
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
} from '@/modules/library/core';

export type { ISpecification };
export {
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
};

export interface ExactMatchCandidateInput {
  cleanDoi: string | null;
  cleanArxiv: string | null;
  cleanPmid: string | null;
  cleanIsbn: string | null;
}

export interface MatchedCandidateIdentifierRow {
  type?: string;
  value?: string;
}

export interface MatchedCandidateRow {
  id: string;
  title: string;
  doi?: string | null;
  metadata?: unknown;
  identifiers?: MatchedCandidateIdentifierRow[];
}

export interface IExactMatchSpecification {
  readonly reason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
  isApplicable(input: ExactMatchCandidateInput): boolean;
  toPrismaOrClauses(input: ExactMatchCandidateInput): Prisma.ItemWhereInput[];
  evaluateMatchedItem(
    input: ExactMatchCandidateInput,
    match: MatchedCandidateRow,
  ): Record<string, string> | null;
  isSatisfiedByRow(
    match: MatchedCandidateRow,
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null;
  buildFallbackEvidence(
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null;
}

function asMetaRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function stripArxivVersion(arxivId: string): string {
  return arxivId.replace(/v\d+$/i, '');
}

function getIdentifierValue(
  rowOrIdents:
    MatchedCandidateRow | MatchedCandidateIdentifierRow[] | undefined,
  type: string,
): string {
  if (!rowOrIdents) return '';
  const normType = type.toLowerCase();

  // If passed an array directly
  if (Array.isArray(rowOrIdents)) {
    const found = rowOrIdents.find(
      (i) => (i.type || '').toLowerCase() === normType,
    );
    return (found?.value || '').trim();
  }

  // If passed MatchedCandidateRow
  const row = rowOrIdents;
  if (Array.isArray(row.identifiers) && row.identifiers.length > 0) {
    const found = row.identifiers.find(
      (i) => (i.type || '').toLowerCase() === normType,
    );
    if (found?.value) return (found.value || '').trim();
  }

  const meta = asMetaRecord(row.metadata);
  if (Array.isArray(meta.identifiers)) {
    const found = (meta.identifiers as Array<Record<string, unknown>>).find(
      (i) =>
        i &&
        typeof i === 'object' &&
        String(i.type || '').toLowerCase() === normType,
    );
    if (found?.value) return String(found.value).trim();
  }

  return '';
}

export function hasAnyPopulatedIdentifier(match: MatchedCandidateRow): boolean {
  const meta = asMetaRecord(match.metadata);
  const idents = Array.isArray(match.identifiers) ? match.identifiers : [];
  const metaIdents = Array.isArray(meta.identifiers) ? meta.identifiers : [];
  const metaArxiv = String(
    meta.arxivId || meta.archiveId || meta.archiveID || '',
  ).trim();
  return Boolean(
    (typeof match.doi === 'string' && match.doi.trim()) ||
    meta.doi ||
    metaArxiv ||
    meta.pmid ||
    meta.isbn ||
    idents.length > 0 ||
    metaIdents.length > 0,
  );
}

export class DoiExactMatchSpecification implements IExactMatchSpecification {
  readonly reason = 'DOI_EXACT' as const;

  isApplicable(input: ExactMatchCandidateInput): boolean {
    return Boolean(input.cleanDoi && input.cleanDoi.trim().length > 0);
  }

  toPrismaOrClauses(input: ExactMatchCandidateInput): Prisma.ItemWhereInput[] {
    if (!this.isApplicable(input) || !input.cleanDoi) return [];
    const cleanDoi = input.cleanDoi.trim().toLowerCase();
    return [
      { doi: { equals: cleanDoi, mode: 'insensitive' } },
      { metadata: { path: ['doi'], equals: cleanDoi } },
      {
        identifiers: {
          some: {
            type: 'doi',
            value: { equals: cleanDoi, mode: 'insensitive' },
          },
        },
      },
    ];
  }

  evaluateMatchedItem(
    input: ExactMatchCandidateInput,
    match: MatchedCandidateRow,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanDoi) return null;
    const cleanDoi = input.cleanDoi.trim().toLowerCase();
    const meta = asMetaRecord(match.metadata);
    const identDoi = getIdentifierValue(match, 'doi').toLowerCase();
    const isDoiMatch = Boolean(
      (typeof match.doi === 'string' &&
        match.doi.trim().toLowerCase() === cleanDoi) ||
      (typeof meta.doi === 'string' &&
        meta.doi.trim().toLowerCase() === cleanDoi) ||
      identDoi === cleanDoi,
    );

    if (isDoiMatch) {
      return { doi: cleanDoi };
    }
    return null;
  }

  isSatisfiedByRow(
    match: MatchedCandidateRow,
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    return this.evaluateMatchedItem(input, match);
  }

  buildFallbackEvidence(
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanDoi) return null;
    return { doi: input.cleanDoi.trim().toLowerCase() };
  }
}

export class ArxivExactMatchSpecification implements IExactMatchSpecification {
  readonly reason = 'ARXIV_EXACT' as const;

  isApplicable(input: ExactMatchCandidateInput): boolean {
    return Boolean(input.cleanArxiv && input.cleanArxiv.trim().length > 0);
  }

  toPrismaOrClauses(input: ExactMatchCandidateInput): Prisma.ItemWhereInput[] {
    if (!this.isApplicable(input) || !input.cleanArxiv) return [];
    const cleanArxiv = input.cleanArxiv.trim();
    const baseArxiv = stripArxivVersion(cleanArxiv);
    return [
      { metadata: { path: ['arxivId'], equals: cleanArxiv } },
      { metadata: { path: ['arxivId'], equals: baseArxiv } },
      { metadata: { path: ['arxiv'], equals: cleanArxiv } },
      { metadata: { path: ['arxiv'], equals: baseArxiv } },
      { metadata: { path: ['archiveID'], equals: cleanArxiv } },
      { metadata: { path: ['archiveID'], equals: baseArxiv } },
      { metadata: { path: ['archiveID'], equals: `arXiv:${baseArxiv}` } },
      {
        identifiers: {
          some: {
            type: 'arxiv',
            value: { in: [cleanArxiv, baseArxiv], mode: 'insensitive' },
          },
        },
      },
    ];
  }

  evaluateMatchedItem(
    input: ExactMatchCandidateInput,
    match: MatchedCandidateRow,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanArxiv) return null;
    const cleanArxiv = input.cleanArxiv.trim();
    const baseArxiv = stripArxivVersion(cleanArxiv);
    const meta = asMetaRecord(match.metadata);
    const metaArxiv = String(
      meta.arxivId || meta.archiveId || meta.archiveID || '',
    )
      .replace(/^arxiv:\s*/i, '')
      .trim()
      .toLowerCase();
    const identArxiv = (
      getIdentifierValue(match, 'arxiv') || getIdentifierValue(match, 'arxivId')
    )
      .replace(/^arxiv:\s*/i, '')
      .toLowerCase();
    const cleanArxivLower = cleanArxiv.toLowerCase();
    const baseArxivLower = baseArxiv.toLowerCase();

    const isArxivMatch = Boolean(
      metaArxiv === cleanArxivLower ||
      metaArxiv === baseArxivLower ||
      (metaArxiv && stripArxivVersion(metaArxiv) === baseArxivLower) ||
      identArxiv === cleanArxivLower ||
      identArxiv === baseArxivLower ||
      (identArxiv && stripArxivVersion(identArxiv) === baseArxivLower),
    );

    if (isArxivMatch) {
      return { arxivId: cleanArxiv };
    }
    return null;
  }

  isSatisfiedByRow(
    match: MatchedCandidateRow,
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    return this.evaluateMatchedItem(input, match);
  }

  buildFallbackEvidence(
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanArxiv) return null;
    return { arxivId: input.cleanArxiv.trim() };
  }
}

export class PmidExactMatchSpecification implements IExactMatchSpecification {
  readonly reason = 'PMID_EXACT' as const;

  isApplicable(input: ExactMatchCandidateInput): boolean {
    return Boolean(input.cleanPmid && input.cleanPmid.trim().length > 0);
  }

  toPrismaOrClauses(input: ExactMatchCandidateInput): Prisma.ItemWhereInput[] {
    if (!this.isApplicable(input) || !input.cleanPmid) return [];
    const cleanPmid = input.cleanPmid.trim();
    return [
      { metadata: { path: ['pmid'], equals: cleanPmid } },
      {
        identifiers: {
          some: {
            type: 'pmid',
            value: { equals: cleanPmid, mode: 'insensitive' },
          },
        },
      },
    ];
  }

  evaluateMatchedItem(
    input: ExactMatchCandidateInput,
    match: MatchedCandidateRow,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanPmid) return null;
    const cleanPmid = input.cleanPmid.trim();
    const meta = asMetaRecord(match.metadata);
    const identPmid = getIdentifierValue(match, 'pmid');
    const isPmidMatch = Boolean(
      String(meta.pmid || '').trim() === cleanPmid || identPmid === cleanPmid,
    );

    if (isPmidMatch) {
      return { pmid: cleanPmid };
    }
    return null;
  }

  isSatisfiedByRow(
    match: MatchedCandidateRow,
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    return this.evaluateMatchedItem(input, match);
  }

  buildFallbackEvidence(
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanPmid) return null;
    return { pmid: input.cleanPmid.trim() };
  }
}

export class IsbnExactMatchSpecification implements IExactMatchSpecification {
  readonly reason = 'ISBN_EXACT' as const;

  isApplicable(input: ExactMatchCandidateInput): boolean {
    return Boolean(input.cleanIsbn && input.cleanIsbn.trim().length > 0);
  }

  toPrismaOrClauses(input: ExactMatchCandidateInput): Prisma.ItemWhereInput[] {
    if (!this.isApplicable(input) || !input.cleanIsbn) return [];
    const cleanIsbn = input.cleanIsbn.replace(/[-\s]/g, '').trim();
    return [
      { metadata: { path: ['isbn'], equals: cleanIsbn } },
      {
        identifiers: {
          some: {
            type: 'isbn',
            value: { equals: cleanIsbn, mode: 'insensitive' },
          },
        },
      },
    ];
  }

  evaluateMatchedItem(
    input: ExactMatchCandidateInput,
    match: MatchedCandidateRow,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanIsbn) return null;
    const cleanIsbn = input.cleanIsbn.replace(/[-\s]/g, '').trim();
    const meta = asMetaRecord(match.metadata);
    const identIsbn = getIdentifierValue(match, 'isbn').replace(/[-\s]/g, '');
    const isIsbnMatch = Boolean(
      String(meta.isbn || '')
        .replace(/[-\s]/g, '')
        .trim() === cleanIsbn || identIsbn === cleanIsbn,
    );

    if (isIsbnMatch) {
      return { isbn: cleanIsbn };
    }
    return null;
  }

  isSatisfiedByRow(
    match: MatchedCandidateRow,
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    return this.evaluateMatchedItem(input, match);
  }

  buildFallbackEvidence(
    input: ExactMatchCandidateInput,
  ): Record<string, string> | null {
    if (!this.isApplicable(input) || !input.cleanIsbn) return null;
    return { isbn: input.cleanIsbn.replace(/[-\s]/g, '').trim() };
  }
}

export const EXACT_MATCH_SPECIFICATIONS: readonly IExactMatchSpecification[] = [
  new DoiExactMatchSpecification(),
  new ArxivExactMatchSpecification(),
  new PmidExactMatchSpecification(),
  new IsbnExactMatchSpecification(),
];

export function normalizeExactMatchCandidateInput(criteria: {
  doi?: string | null;
  arxivId?: string | null;
  pmid?: string | null;
  isbn?: string | null;
}): ExactMatchCandidateInput {
  return {
    cleanDoi: criteria.doi?.trim() ? criteria.doi.trim().toLowerCase() : null,
    cleanArxiv: criteria.arxivId?.trim() ? criteria.arxivId.trim() : null,
    cleanPmid: criteria.pmid?.trim() ? criteria.pmid.trim() : null,
    cleanIsbn: criteria.isbn?.trim()
      ? criteria.isbn.replace(/[-\s]/g, '').trim()
      : null,
  };
}

export function buildExactMatchOrClauses(
  input: ExactMatchCandidateInput,
): Prisma.ItemWhereInput[] {
  const clauses: Prisma.ItemWhereInput[] = [];
  for (const spec of EXACT_MATCH_SPECIFICATIONS) {
    if (spec.isApplicable(input)) {
      clauses.push(...spec.toPrismaOrClauses(input));
    }
  }
  return clauses;
}

export function evaluateExactMatchSpecifications(
  input: ExactMatchCandidateInput,
  match: MatchedCandidateRow,
): {
  id: string;
  title: string;
  matchReason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
  evidence: Record<string, string>;
} | null {
  for (const spec of EXACT_MATCH_SPECIFICATIONS) {
    if (!spec.isApplicable(input)) continue;
    const evidence = spec.isSatisfiedByRow(match, input);
    if (evidence) {
      return {
        id: match.id,
        title: match.title,
        matchReason: spec.reason,
        evidence,
      };
    }
  }

  if (!hasAnyPopulatedIdentifier(match)) {
    for (const spec of EXACT_MATCH_SPECIFICATIONS) {
      if (!spec.isApplicable(input)) continue;
      const fallbackEvidence = spec.buildFallbackEvidence(input);
      if (fallbackEvidence) {
        return {
          id: match.id,
          title: match.title,
          matchReason: spec.reason,
          evidence: fallbackEvidence,
        };
      }
    }
  }

  return null;
}
