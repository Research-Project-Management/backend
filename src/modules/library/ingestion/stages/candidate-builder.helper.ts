import { randomUUID } from 'crypto';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import { ParsedBibtexEntry } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';

export function buildEvidenceFields(
  rawMetadata: Record<string, unknown>,
  normalizedMetadata: Record<string, unknown>,
  sourceName: string,
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
        confidence: 0.95,
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
      ...buildEvidenceFields(params.rawMetadata, normalized, params.sourceName),
      ...(params.fieldOverrides || {}),
    },
    normalizedMetadata: normalized,
    confidenceScore: params.confidenceScore,
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
