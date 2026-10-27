import { randomUUID } from 'crypto';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import { ParsedBibtexEntry } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { ItemProvenancePolicy } from '@/modules/library/core';

export function buildEvidenceFields(
  rawMetadata: Record<string, unknown>,
  normalizedMetadata: Record<string, unknown>,
  sourceName: string,
  defaultConfidence = 0.95,
): Record<string, FieldEvidence> {
  const fields: Record<string, FieldEvidence> = {};
  for (const fieldName of Object.keys(normalizedMetadata)) {
    if (
      normalizedMetadata[fieldName] !== undefined &&
      normalizedMetadata[fieldName] !== null
    ) {
      fields[fieldName] = {
        path: fieldName,
        value: rawMetadata[fieldName],
        normalizedValue: normalizedMetadata[fieldName],
        confidence: defaultConfidence,
        sourceProvider: sourceName,
        retrievedAt: new Date().toISOString(),
      };
    }
  }
  return fields;
}

export function createCandidate(params: {
  sourceKind: MetadataCandidate['sourceKind'];
  sourceName: string;
  sourceRecordId?: string;
  rawMetadata: Record<string, unknown>;
  normalizedMetadata?: Record<string, unknown>;
  confidenceScore: number;
  fieldOverrides?: Record<string, FieldEvidence>;
  normalizer: NormalizationPolicy;
}): MetadataCandidate {
  const normalized =
    params.normalizedMetadata ??
    params.normalizer.normalize(params.rawMetadata);

  return {
    candidateId: randomUUID(),
    sourceKind: params.sourceKind,
    sourceName: params.sourceName,
    sourceRecordId: params.sourceRecordId,
    retrievedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    fields: {
      ...buildEvidenceFields(
        params.rawMetadata,
        normalized,
        params.sourceName,
        params.confidenceScore,
      ),
      ...(params.fieldOverrides || {}),
    },
    normalizedMetadata: normalized,
    confidenceScore: params.confidenceScore,
  };
}

/**
 * Applies explicit user overrides onto an identified MetadataCandidate so that both
 * `normalizedMetadata` AND `fields` (`FieldEvidence`) carry `UserOverride` provenance
 * (`confidence: 1.0`, `isUserOverride: true`) and survive downstream reconciliation.
 */
export function applyUserOverridesToCandidate(
  candidate: MetadataCandidate,
  overrides: Record<string, unknown> | undefined,
  normalizer: NormalizationPolicy,
): MetadataCandidate {
  if (!overrides || Object.keys(overrides).length === 0) {
    return candidate;
  }

  // Clear coupled aliases from base candidate metadata before merging overrides so stale candidate
  // alias values (e.g. `journal` when user overrode `publicationTitle`) cannot survive normalization.
  const baseMetaClean: Record<string, unknown> = {
    ...(candidate.normalizedMetadata || {}),
  };
  const explicitOverrideKeys = new Set<string>();
  const coupledOverrideKeys = new Set<string>();

  for (const [key, rawVal] of Object.entries(overrides)) {
    if (rawVal === undefined || rawVal === null) continue;
    explicitOverrideKeys.add(key);
    for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(key)) {
      if (!(alias in overrides)) {
        delete baseMetaClean[alias];
      }
      coupledOverrideKeys.add(alias);
    }
  }

  const mergedNormalized = normalizer.normalize({
    ...baseMetaClean,
    ...overrides,
  });
  const nowIso = new Date().toISOString();
  const updatedFields: Record<string, FieldEvidence> = {
    ...(candidate.fields || {}),
  };

  for (const key of explicitOverrideKeys) {
    const rawVal = overrides[key];
    const normVal =
      (mergedNormalized as Record<string, unknown>)[key] ?? rawVal;
    updatedFields[key] = {
      path: key,
      value: rawVal,
      normalizedValue: normVal,
      confidence: 1.0,
      sourceProvider: 'UserOverride',
      retrievedAt: nowIso,
      isUserOverride: true,
    };
  }

  for (const aliasKey of coupledOverrideKeys) {
    if (explicitOverrideKeys.has(aliasKey)) continue;
    const aliasVal = (mergedNormalized as Record<string, unknown>)[aliasKey];
    if (aliasVal === undefined || aliasVal === null) continue;
    updatedFields[aliasKey] = {
      path: aliasKey,
      value: aliasVal,
      normalizedValue: aliasVal,
      confidence: 1.0,
      sourceProvider: 'UserOverride',
      retrievedAt: nowIso,
      isUserOverride: true,
    };
  }

  return {
    ...candidate,
    fields: updatedFields,
    normalizedMetadata: mergedNormalized,
  };
}

export function mapBibtexToRawRecord(
  item: ParsedBibtexEntry | Record<string, unknown>,
): Record<string, unknown> {
  const extraFields: Record<string, unknown> = {
    ...(typeof item.extraFields === 'object' && item.extraFields !== null
      ? (item.extraFields as Record<string, unknown>)
      : {}),
    ...(item.university ? { university: item.university } : {}),
    ...(item.institution ? { institution: item.institution } : {}),
    ...(item.thesisType ? { thesisType: item.thesisType } : {}),
    ...(item.reportNumber ? { reportNumber: item.reportNumber } : {}),
    ...(item.reportType ? { reportType: item.reportType } : {}),
    ...(item.bookTitle ? { bookTitle: item.bookTitle } : {}),
    ...(item.proceedingsTitle
      ? { proceedingsTitle: item.proceedingsTitle }
      : {}),
    ...(item.conferenceName ? { conferenceName: item.conferenceName } : {}),
    ...(item.eventPlace ? { eventPlace: item.eventPlace } : {}),
    ...(item.numPages
      ? {
          numPages: Number(item.numPages) || item.numPages,
          numberOfPages: Number(item.numPages) || item.numPages,
        }
      : {}),
    ...(item.numberOfVolumes ? { numberOfVolumes: item.numberOfVolumes } : {}),
    ...(item.seriesNumber ? { seriesNumber: item.seriesNumber } : {}),
    ...(item.chapter ? { chapter: item.chapter } : {}),
  };

  return {
    title: item.title,
    shortTitle: item.shortTitle,
    itemType: item.itemType,
    authors: item.authors,
    editors: item.editors,
    creators: item.creators,
    year: item.year,
    publicationDate: item.publicationDate,
    publicationTitle: item.journal || item.proceedingsTitle || item.bookTitle,
    journal: item.journal,
    journalAbbr: item.journalAbbr,
    publisher: item.publisher || item.university || item.institution,
    university: item.university,
    institution: item.institution,
    thesisType: item.thesisType,
    reportNumber: item.reportNumber,
    reportType: item.reportType,
    bookTitle: item.bookTitle,
    proceedingsTitle: item.proceedingsTitle,
    conferenceName: item.conferenceName,
    eventPlace: item.eventPlace,
    place: item.place,
    volume: item.volume,
    issue: item.issue,
    pages: item.pages,
    numPages: item.numPages,
    numberOfPages: item.numPages
      ? Number(item.numPages) || undefined
      : undefined,
    numberOfVolumes: item.numberOfVolumes,
    series: item.series,
    seriesNumber: item.seriesNumber,
    chapter: item.chapter,
    edition: item.edition,
    arxivId: item.arxivId,
    doi: item.doi,
    pmid: item.pmid,
    pmcid: item.pmcid,
    isbn: item.isbn,
    issn: item.issn,
    url: item.url,
    accessedAt: item.accessedAt,
    abstract: item.abstract,
    citationKey: item.citationKey,
    tags: item.keywords,
    keywords: item.keywords,
    notes: Array.isArray(item.notes)
      ? (item.notes as string[]).map((n: string) => ({
          content: n,
          source: 'bibtex',
        }))
      : undefined,
    language: item.language,
    rights: item.rights,
    fileUrl: item.fileUrl,
    extra: item.extra,
    extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    seeAlso: item.seeAlso,
    relations: item.relations,
  };
}
