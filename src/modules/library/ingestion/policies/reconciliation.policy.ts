import {
  MetadataCandidate,
  FieldEvidence,
  ReconciliationDecision,
  MetadataConflictDetail,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import {
  selectAuthoritativeCreatorVariant,
  countFullGivenNames,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  resolveFieldReconciliationStrategy,
  WeightedFieldVariant,
  finalizeReconciledBibliographicMetadata,
} from '@/modules/library/ingestion/domain/field-reconciliation.strategies';
import {
  resolveFieldAliases,
  resolveBidirectionalBaseFields,
  resolveProviderFieldWeight,
  SOURCE_WEIGHTS,
  FIELD_AUTHORITY_WEIGHTS,
  FIELD_AUTHORITY,
} from '@/modules/library/core';

export {
  selectAuthoritativeCreatorVariant,
  countFullGivenNames,
  mergeReconciledTagArrays,
  mergeReconciledNotesArrays,
  mergeReconciledExtraText,
  resolveFieldReconciliationStrategy,
  finalizeReconciledBibliographicMetadata,
  SOURCE_WEIGHTS,
  FIELD_AUTHORITY_WEIGHTS,
  FIELD_AUTHORITY,
  resolveProviderFieldWeight,
};
export type { WeightedFieldVariant };

export const ALIAS_EVIDENCE_FALLBACK_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  publicationTitle: [
    'publicationTitle',
    'journal',
    'venue',
    'proceedingsTitle',
    'conferenceName',
    'bookTitle',
    'websiteTitle',
    'reporter',
    'code',
  ],
  journal: ['journal', 'publicationTitle', 'venue'],
  abstract: ['abstract', 'abstractNote'],
  abstractNote: ['abstractNote', 'abstract'],
  authors: ['authors', 'creators'],
  creators: ['creators', 'authors'],
  arxivId: ['arxivId', 'archiveId', 'archiveID'],
  archiveId: ['archiveId', 'arxivId', 'archiveID'],
  journalAbbreviation: ['journalAbbreviation', 'journalAbbr'],
  journalAbbr: ['journalAbbr', 'journalAbbreviation'],
  publicationDate: [
    'publicationDate',
    'date',
    'dateDecided',
    'dateEnacted',
    'issueDate',
    'filingDate',
  ],
  date: [
    'date',
    'publicationDate',
    'dateDecided',
    'dateEnacted',
    'issueDate',
    'filingDate',
  ],
  publisher: [
    'publisher',
    'university',
    'institution',
    'repository',
    'issuingAuthority',
    'court',
  ],
  place: ['place', 'eventPlace', 'country'],
  eventPlace: ['eventPlace', 'place'],
  issue: [
    'issue',
    'number',
    'reportNumber',
    'docketNumber',
    'publicLawNumber',
    'patentNumber',
  ],
  number: [
    'number',
    'issue',
    'reportNumber',
    'docketNumber',
    'publicLawNumber',
    'patentNumber',
  ],
  numPages: ['numPages', 'numberOfPages'],
  numberOfPages: ['numberOfPages', 'numPages'],
  authority: ['authority', 'issuingAuthority', 'court'],
  issuingAuthority: ['issuingAuthority', 'authority'],
  doi: ['doi', 'DOI'],
  isbn: ['isbn', 'ISBN'],
  issn: ['issn', 'ISSN'],
  pmid: ['pmid', 'PMID'],
  pmcid: ['pmcid', 'PMCID'],
  url: ['url', 'URL'],
  rights: ['rights', 'license'],
  license: ['license', 'rights'],
};

interface AnnotatedFieldEvidence extends FieldEvidence {
  readonly __isAlreadyWeighted?: boolean;
}

export class ReconciliationPolicy {
  private static getProviderPriority(
    provider: string,
    field?: string,
    isAlreadyWeighted?: boolean,
    isUserOverride?: boolean,
  ): number {
    if (
      isUserOverride ||
      provider === 'UserOverride' ||
      provider === 'user' ||
      provider === 'manual'
    ) {
      return 1000;
    }
    if (
      isAlreadyWeighted &&
      (!provider ||
        provider === 'EnrichedProvider' ||
        provider === 'MetadataResolution')
    ) {
      return 100;
    }
    return resolveProviderFieldWeight(provider, field ?? '') * 100;
  }

  /**
   * Reconciles multiple candidates into a single canonical proposal with full field provenance.
   */
  reconcile(candidates: MetadataCandidate[]): ReconciliationDecision {
    if (!candidates || candidates.length === 0) {
      return {
        selectedFields: {},
        rejectedFields: {},
        conflicts: [],
        proposedItem: { title: 'Untitled Record' },
        decidedAt: new Date().toISOString(),
        policyVersion: '1.1.0',
      };
    }

    // Collect all field variants across candidates after alias & base-field harmonization
    const fieldMap = new Map<string, AnnotatedFieldEvidence[]>();

    for (const candidate of candidates) {
      if (!candidate?.fields || typeof candidate.fields !== 'object') {
        continue;
      }
      const isAlreadyWeighted =
        candidate.sourceName === 'EnrichedProvider' ||
        (candidate as { source?: string; sourceProvider?: string }).source ===
          'EnrichedProvider' ||
        (candidate as { source?: string; sourceProvider?: string })
          .sourceProvider === 'EnrichedProvider';

      const harmonizedMeta: Record<string, unknown> = {};
      const fieldEvidences = candidate.fields;
      let fallbackEvidence: FieldEvidence | undefined;

      for (const [key, evidence] of Object.entries(fieldEvidences)) {
        if (
          !evidence ||
          evidence.normalizedValue === undefined ||
          evidence.normalizedValue === null
        ) {
          continue;
        }
        if (
          !fallbackEvidence &&
          !evidence.isUserOverride &&
          evidence.sourceProvider !== 'UserOverride'
        ) {
          fallbackEvidence = evidence;
        }
        harmonizedMeta[key] = evidence.normalizedValue;
      }

      if (!fallbackEvidence) {
        fallbackEvidence = Object.values(fieldEvidences).find(
          (ev): ev is FieldEvidence =>
            Boolean(ev) &&
            ev.normalizedValue !== undefined &&
            ev.normalizedValue !== null,
        );
      }
      if (!fallbackEvidence) {
        continue;
      }

      const candType = String(
        harmonizedMeta.itemType ||
          candidate.normalizedMetadata?.itemType ||
          'journalArticle',
      );
      resolveFieldAliases(harmonizedMeta);
      resolveBidirectionalBaseFields(
        harmonizedMeta,
        candType,
        undefined,
        false,
      );
      if (
        harmonizedMeta.abstractNote !== undefined &&
        harmonizedMeta.abstract === undefined
      ) {
        harmonizedMeta.abstract = harmonizedMeta.abstractNote;
      }

      for (const [key, normVal] of Object.entries(harmonizedMeta)) {
        if (normVal === undefined || normVal === null || normVal === '') {
          continue;
        }
        let baseEv = fieldEvidences[key];
        if (!baseEv) {
          const fallbackKeys = ALIAS_EVIDENCE_FALLBACK_KEYS[key] || [];
          for (const fk of fallbackKeys) {
            if (fieldEvidences[fk]) {
              baseEv = fieldEvidences[fk];
              break;
            }
          }
        }
        const effectiveBase = baseEv || fallbackEvidence;
        const resolvedProvider =
          (effectiveBase.sourceProvider &&
          effectiveBase.sourceProvider !== 'EnrichedProvider' &&
          effectiveBase.sourceProvider !== 'MetadataResolution'
            ? effectiveBase.sourceProvider
            : (effectiveBase as { source?: string }).source) ||
          effectiveBase.sourceProvider ||
          (candidate as { sourceProvider?: string }).sourceProvider ||
          candidate.sourceName;
        const evidenceToPush: AnnotatedFieldEvidence =
          effectiveBase.path === key &&
          effectiveBase.normalizedValue === normVal &&
          effectiveBase.sourceProvider === resolvedProvider &&
          !isAlreadyWeighted
            ? effectiveBase
            : {
                ...effectiveBase,
                path: key,
                normalizedValue: normVal,
                sourceProvider: resolvedProvider,
                ...(isAlreadyWeighted ? { __isAlreadyWeighted: true } : {}),
              };
        const existing = fieldMap.get(key) || [];
        existing.push(evidenceToPush);
        fieldMap.set(key, existing);
      }
    }

    const selectedFields: Record<string, FieldEvidence> = {};
    const rejectedFields: Record<string, FieldEvidence[]> = {};
    const conflicts: MetadataConflictDetail[] = [];
    const proposedItem: Record<string, unknown> = {};

    const stripInternalAnnotation = (
      ev: AnnotatedFieldEvidence,
    ): FieldEvidence => {
      if (!('__isAlreadyWeighted' in ev)) return ev;
      const { __isAlreadyWeighted: _, ...clean } = ev;
      return clean;
    };

    for (const [field, evidences] of fieldMap.entries()) {
      if (evidences.length === 1) {
        selectedFields[field] = stripInternalAnnotation(evidences[0]);
        proposedItem[field] = evidences[0].normalizedValue;
        rejectedFields[field] = [];
        continue;
      }

      // Sort by effective weight: confidence * provider priority
      const sorted = [...evidences].sort((a, b) => {
        const priorityA = ReconciliationPolicy.getProviderPriority(
          a.sourceProvider,
          field,
          a.__isAlreadyWeighted,
          a.isUserOverride,
        );
        const priorityB = ReconciliationPolicy.getProviderPriority(
          b.sourceProvider,
          field,
          b.__isAlreadyWeighted,
          b.isUserOverride,
        );
        const scoreA = a.confidence * priorityA;
        const scoreB = b.confidence * priorityB;
        if (scoreB !== scoreA) {
          return scoreB - scoreA;
        }
        // Tie-breaker for two EnrichedProvider fields: use actual provider field weight
        return (
          resolveProviderFieldWeight(b.sourceProvider, field) -
          resolveProviderFieldWeight(a.sourceProvider, field)
        );
      });

      const best = sorted[0];

      const strategy = resolveFieldReconciliationStrategy(field);
      const weightedVariants: WeightedFieldVariant[] = sorted.map((ev, idx) => {
        const isEvUserOverride =
          Boolean(ev.isUserOverride) ||
          ev.sourceProvider === 'UserOverride' ||
          ev.sourceProvider === 'user' ||
          ev.sourceProvider === 'manual';
        return {
          candidate: {
            id: `${ev.sourceProvider}:${field}:${idx}`,
            sourceProvider: ev.sourceProvider,
            confidenceScore: ev.confidence,
            metadata: { [field]: ev.normalizedValue } as never,
            fetchedAt: ev.retrievedAt || new Date().toISOString(),
          },
          val: ev.normalizedValue,
          effectiveWeight:
            (ev.confidence *
              ReconciliationPolicy.getProviderPriority(
                ev.sourceProvider,
                field,
                ev.__isAlreadyWeighted,
                ev.isUserOverride,
              )) /
            100,
          isUserOverride: isEvUserOverride,
        };
      });
      const outcome = strategy.reconcileField(field, weightedVariants);

      if (!outcome.detectConflicts) {
        const isBestUserOverride =
          Boolean(best.isUserOverride) ||
          best.sourceProvider === 'UserOverride' ||
          best.sourceProvider === 'user' ||
          best.sourceProvider === 'manual';
        const resolvedVal =
          field === 'notes'
            ? mergeReconciledNotesArrays(
                (isBestUserOverride ? [best] : evidences).map(
                  (ev) => ev.normalizedValue,
                ),
                true,
              )
            : outcome.value;
        selectedFields[field] = {
          ...stripInternalAnnotation(best),
          normalizedValue: resolvedVal,
          ...(outcome.assertion.isUserOverride ? { isUserOverride: true } : {}),
        };
        proposedItem[field] = resolvedVal;
        rejectedFields[field] = [];
        continue;
      }

      const winningEvidence =
        sorted.find(
          (ev) =>
            ev.sourceProvider === outcome.assertion.sourceProvider &&
            ev.normalizedValue === outcome.value,
        ) ?? best;

      selectedFields[field] = stripInternalAnnotation(winningEvidence);
      proposedItem[field] = outcome.value;
      rejectedFields[field] = sorted
        .filter((e) => e !== winningEvidence)
        .map(stripInternalAnnotation);

      // Conflict detection for non-array values with differing string representations
      if (typeof best.normalizedValue !== 'object') {
        const divergent = sorted.filter(
          (e) =>
            String(e.normalizedValue).toLowerCase() !==
            String(best.normalizedValue).toLowerCase(),
        );

        if (divergent.length > 0) {
          const highConfidenceDivergent = divergent.filter(
            (e) => e.confidence >= 0.8,
          );
          conflicts.push({
            field,
            description: `Divergent values found for field "${field}" across providers`,
            severity: highConfidenceDivergent.length > 0 ? 'high' : 'medium',
            variants: sorted.map((e) => ({
              sourceProvider: e.sourceProvider,
              value: e.normalizedValue,
              confidenceScore: e.confidence,
            })),
          });
        }
      }
    }

    finalizeReconciledBibliographicMetadata(
      proposedItem,
      candidates.map((c) => ({
        sourceProvider:
          (c as { sourceProvider?: string }).sourceProvider || c.sourceName,
        metadata:
          (c.normalizedMetadata as unknown as Record<string, unknown>) ??
          (c.fields as unknown as Record<string, unknown>),
      })),
    );
    for (const syncKey of [
      'publicationDate',
      'date',
      'authors',
      'creators',
    ] as const) {
      if (
        selectedFields[syncKey] &&
        proposedItem[syncKey] !== undefined &&
        selectedFields[syncKey].normalizedValue !== proposedItem[syncKey]
      ) {
        selectedFields[syncKey] = {
          ...selectedFields[syncKey],
          normalizedValue: proposedItem[syncKey],
        };
      }
    }

    const fieldProvenance: Record<
      string,
      {
        source: string;
        sourceProvider: string;
        confidence: number;
        verified: boolean;
        isUserOverride?: boolean;
        lockedByUser?: boolean;
      }
    > = {};
    const userOverrideFieldKeys = new Set<string>();
    for (const [fKey, fEv] of Object.entries(selectedFields)) {
      if (!fEv || fKey === 'extraFields' || fKey === 'notes') continue;
      const isUser =
        Boolean(fEv.isUserOverride) ||
        fEv.sourceProvider === 'UserOverride' ||
        fEv.sourceProvider === 'user' ||
        fEv.sourceProvider === 'manual';
      if (isUser) {
        userOverrideFieldKeys.add(fKey);
      }
      fieldProvenance[fKey] = {
        source: fEv.sourceProvider,
        sourceProvider: fEv.sourceProvider,
        confidence: fEv.confidence,
        verified: fEv.confidence >= 0.7 || isUser,
        ...(isUser ? { isUserOverride: true, lockedByUser: true } : {}),
      };
    }

    const existingExtra =
      proposedItem.extraFields &&
      typeof proposedItem.extraFields === 'object' &&
      !Array.isArray(proposedItem.extraFields)
        ? (proposedItem.extraFields as Record<string, unknown>)
        : {};
    const existingFieldProv =
      existingExtra.fieldProvenance &&
      typeof existingExtra.fieldProvenance === 'object' &&
      !Array.isArray(existingExtra.fieldProvenance)
        ? (existingExtra.fieldProvenance as Record<string, unknown>)
        : {};
    const existingLocked = Array.isArray(existingExtra.lockedFields)
      ? (existingExtra.lockedFields as string[])
      : [];
    const mergedLockedFields = Array.from(
      new Set([...existingLocked, ...userOverrideFieldKeys]),
    );

    proposedItem.extraFields = {
      ...existingExtra,
      fieldProvenance: {
        ...fieldProvenance,
        ...existingFieldProv,
      },
      ...(mergedLockedFields.length > 0
        ? { lockedFields: mergedLockedFields }
        : {}),
    };

    return {
      selectedFields,
      rejectedFields,
      conflicts,
      proposedItem: proposedItem,
      decidedAt: new Date().toISOString(),
      policyVersion: '1.1.0',
    };
  }

  private static extractCandidateSurname(raw: unknown): string {
    if (!raw) return '';
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return '';
      const part = trimmed.includes(',')
        ? trimmed.split(',')[0].trim()
        : trimmed;
      return (part.split(/\s+/).pop() || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    }
    if (typeof raw === 'object') {
      const rec = raw as Record<string, unknown>;
      const candidate =
        (typeof rec.lastName === 'string' && rec.lastName.trim()) ||
        (typeof rec.family === 'string' && rec.family.trim()) ||
        (typeof rec.fullName === 'string' && rec.fullName.trim()) ||
        (typeof rec.name === 'string' && rec.name.trim()) ||
        '';
      return ReconciliationPolicy.extractCandidateSurname(candidate);
    }
    return '';
  }

  private static extractCandidateAuthorSurnames(authors: unknown): Set<string> {
    const set = new Set<string>();
    if (!Array.isArray(authors)) return set;
    for (const a of authors) {
      const s = ReconciliationPolicy.extractCandidateSurname(a);
      if (s) set.add(s);
    }
    return set;
  }

  static verifyCandidateMatch(
    recordCand: MetadataCandidate,
    providerCand: MetadataCandidate,
  ): boolean {
    if (
      providerCand.rawEvidenceRef &&
      recordCand.candidateId &&
      providerCand.rawEvidenceRef === recordCand.candidateId
    ) {
      return true;
    }
    const rMeta = recordCand.normalizedMetadata || {};
    const pMeta = providerCand.normalizedMetadata || {};
    const rDoi = rMeta.doi?.trim().toLowerCase();
    const pDoi = pMeta.doi?.trim().toLowerCase();
    if (rDoi && pDoi && rDoi !== pDoi) return false;
    const rArxiv = rMeta.arxivId?.trim().toLowerCase();
    const pArxiv = pMeta.arxivId?.trim().toLowerCase();
    if (rArxiv && pArxiv && rArxiv !== pArxiv) return false;
    const rPmid = rMeta.pmid?.trim().toLowerCase();
    const pPmid = pMeta.pmid?.trim().toLowerCase();
    if (rPmid && pPmid && rPmid !== pPmid) return false;
    const rIsbn = rMeta.isbn?.trim().toLowerCase();
    const pIsbn = pMeta.isbn?.trim().toLowerCase();
    if (rIsbn && pIsbn && rIsbn !== pIsbn) return false;

    const rYear = Number(rMeta.year);
    const pYear = Number(pMeta.year);
    if (
      Number.isFinite(rYear) &&
      rYear > 0 &&
      Number.isFinite(pYear) &&
      pYear > 0 &&
      Math.abs(rYear - pYear) > 1
    ) {
      return false;
    }

    const rAuthors = ReconciliationPolicy.extractCandidateAuthorSurnames(
      rMeta.authors?.length ? rMeta.authors : rMeta.creators,
    );
    const pAuthors = ReconciliationPolicy.extractCandidateAuthorSurnames(
      pMeta.authors?.length ? pMeta.authors : pMeta.creators,
    );
    if (rAuthors.size > 0 && pAuthors.size > 0) {
      let shared = 0;
      for (const name of rAuthors) {
        if (pAuthors.has(name)) shared++;
      }
      if (shared === 0) return false;
    }

    if (
      providerCand.rawEvidenceRef &&
      recordCand.candidateId &&
      providerCand.rawEvidenceRef !== recordCand.candidateId
    ) {
      if ((rDoi || pDoi) && rDoi !== pDoi) return false;
      if ((rArxiv || pArxiv) && rArxiv !== pArxiv) return false;
      if ((rPmid || pPmid) && rPmid !== pPmid) return false;
      if ((rIsbn || pIsbn) && rIsbn !== pIsbn) return false;
      if ((rAuthors.size === 0) !== (pAuthors.size === 0)) return false;
    }
    return true;
  }
}
