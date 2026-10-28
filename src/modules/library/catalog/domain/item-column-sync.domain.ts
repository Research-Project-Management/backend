import { Prisma } from '@prisma/client';
import {
  harmonizeZoteroFields,
  isPlaceholderItemTitle,
  ItemProvenancePolicy,
} from '@/modules/library/core';
import { ITEM_COLUMN_METADATA_FIELDS } from '@/modules/library/catalog/types/items.constants';

export { ITEM_COLUMN_METADATA_FIELDS };

const TRANSIENT_AI_PATCH_ALIASES = [
  'DOI',
  'ISBN',
  'ISSN',
  'PMID',
  'PMCID',
  'archiveID',
  'citeKey',
  'URL',
] as const;

export interface AiMetadataPatchPreparation {
  filteredPatch: Record<string, unknown>;
  topLevelColumnSync: Record<string, unknown>;
  mergedMetadata: Prisma.InputJsonValue;
}

/**
 * Normalizes, harmonizes, provenance-filters, and computes top-level Prisma column sync
 * for an AI metadata patch against an existing Catalog Item.
 */
export function prepareItemAiMetadataPatch(params: {
  existingTitle?: string | null;
  effectiveItemType: string;
  currentMeta: Record<string, unknown>;
  aiMetadataPatch: Record<string, unknown>;
}): AiMetadataPatchPreparation {
  const { existingTitle, effectiveItemType, currentMeta, aiMetadataPatch } =
    params;

  const rawPatch: Record<string, unknown> = { ...aiMetadataPatch };
  if (rawPatch.URL !== undefined && rawPatch.url === undefined) {
    rawPatch.url = rawPatch.URL;
  }
  delete rawPatch.citationKey;
  delete rawPatch.citeKey;
  delete rawPatch.mergedCitationKeys;

  const hasBibliographicFields = Object.keys(rawPatch).some(
    (k) =>
      ITEM_COLUMN_METADATA_FIELDS.has(k) ||
      ITEM_COLUMN_METADATA_FIELDS.has(k.toLowerCase()),
  );
  const sanitizedPatch = hasBibliographicFields
    ? harmonizeZoteroFields(rawPatch, {
        itemType: effectiveItemType,
        syncExtraFields: false,
        syncLegacyAliases: false,
      })
    : rawPatch;

  for (const transientAlias of TRANSIENT_AI_PATCH_ALIASES) {
    delete sanitizedPatch[transientAlias];
  }

  const { filteredPatch, updatedFieldProvenance } =
    ItemProvenancePolicy.filterAiMetadataPatch(currentMeta, sanitizedPatch);

  const topLevelColumnSync: Record<string, unknown> = {};
  if (updatedFieldProvenance) {
    if (filteredPatch.year !== undefined) {
      const parsedYear =
        typeof filteredPatch.year === 'number'
          ? filteredPatch.year
          : parseInt(String(filteredPatch.year), 10);
      if (!Number.isNaN(parsedYear) && parsedYear >= 1000 && parsedYear <= 2999) {
        topLevelColumnSync.year = parsedYear;
      }
    }
    if (typeof filteredPatch.doi === 'string' && filteredPatch.doi.trim()) {
      topLevelColumnSync.doi = filteredPatch.doi.trim();
    }
    const resolvedAbstract =
      typeof filteredPatch.abstract === 'string' &&
      filteredPatch.abstract.trim()
        ? filteredPatch.abstract.trim()
        : typeof filteredPatch.abstractNote === 'string' &&
            filteredPatch.abstractNote.trim()
          ? filteredPatch.abstractNote.trim()
          : undefined;
    if (resolvedAbstract) {
      topLevelColumnSync.abstract = resolvedAbstract;
    }
    const resolvedVenue =
      typeof filteredPatch.publicationTitle === 'string' &&
      filteredPatch.publicationTitle.trim()
        ? filteredPatch.publicationTitle.trim()
        : typeof filteredPatch.journal === 'string' &&
            filteredPatch.journal.trim()
          ? filteredPatch.journal.trim()
          : typeof filteredPatch.venue === 'string' &&
              filteredPatch.venue.trim()
            ? filteredPatch.venue.trim()
            : undefined;
    if (resolvedVenue) {
      topLevelColumnSync.publicationTitle = resolvedVenue;
    }
    if (typeof filteredPatch.url === 'string' && filteredPatch.url.trim()) {
      topLevelColumnSync.url = filteredPatch.url.trim();
    }
    const existingTitleStr =
      typeof existingTitle === 'string' ? existingTitle.trim() : '';
    const isExistingTitlePlaceholderOrFilename =
      isPlaceholderItemTitle(existingTitleStr) ||
      currentMeta.isFilenameTitle === true ||
      /\.(pdf|docx?|txt|pptx?|xlsx?)$/i.test(existingTitleStr) ||
      (existingTitleStr.includes('_') && !existingTitleStr.includes(' '));
    if (
      typeof filteredPatch.title === 'string' &&
      filteredPatch.title.trim() &&
      isExistingTitlePlaceholderOrFilename
    ) {
      topLevelColumnSync.title = filteredPatch.title.trim();
    }
  }

  const mergedMetadata = {
    ...currentMeta,
    ...filteredPatch,
    ...(updatedFieldProvenance
      ? { fieldProvenance: updatedFieldProvenance }
      : {}),
  } as Prisma.InputJsonValue;

  return {
    filteredPatch,
    topLevelColumnSync,
    mergedMetadata,
  };
}
