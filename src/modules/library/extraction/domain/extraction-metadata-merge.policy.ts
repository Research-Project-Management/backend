import { Prisma, TagType } from '@prisma/client';
import { isUuid } from '@/core';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  normalizeAcademicTags,
  generateCitationKey,
  getPrimaryCreatorRoleForType,
  isPlaceholderItemTitle,
  sanitizeItemTitle,
  cleanAbstractText,
  harmonizeZoteroFields,
  ItemProvenancePolicy,
  inferItemTypeFromPdfSignals,
  resolveProviderFieldWeight,
} from '@/modules/library/core';

export interface ExtractionSyncAttachmentInput {
  id: string;
  itemId: string;
  item?:
    | (Record<string, unknown> & {
        id?: string;
        userId?: string;
        projectId?: string | null;
        title?: string;
        doi?: string | null;
        arxivId?: string | null;
        abstract?: string | null;
        year?: number | null;
        publicationTitle?: string | null;
        itemType?: string | null;
        metadata?: unknown;
      })
    | null;
  [key: string]: unknown;
}

export interface ExtractionSyncDocumentInput {
  references?: unknown[];
  metadata?: {
    keywords?: string[];
    notes?: Array<{ content: string; type?: string }>;
    title?: string;
    doi?: string;
    arxivId?: string;
    abstract?: string;
    year?: number;
    numberOfPages?: number;
    publicationTitle?: string;
    journal?: string;
    proceedingsTitle?: string;
    conferenceName?: string;
    bookTitle?: string;
    isbn?: string;
    issn?: string;
    pmid?: string;
    pmcid?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    publisher?: string;
    place?: string;
    publicationDate?: string;
    primaryCategory?: string;
    authors?: string[];
    creators?: Array<{
      creatorType?: string;
      fullName?: string;
      name?: string;
      firstName?: string;
      lastName?: string;
      fieldMode?: number;
    }>;
    fieldProvenance?: Record<
      string,
      { source?: string; confidence?: number; extractedAt?: string }
    >;
  };
}

export interface FreshItemExtractionTarget {
  userId: string;
  projectId?: string | null;
  citationKey?: string | null;
  title?: string | null;
  doi?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  itemType?: string | null;
  metadata?: unknown;
}

function asMetaRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function canExtractionOverwriteItemType(
  item: { itemType?: string | null; publicationTitle?: string | null } | null | undefined,
  meta: Record<string, unknown>,
  lockedSet: ReadonlySet<string>,
  fieldProvenance: Record<string, unknown>,
): boolean {
  if (lockedSet.has('itemType')) return false;
  const existingEngine = String(meta.engineUsed || meta.sourceProvider || meta.source || '').trim();
  const hasAuthoritativeJournalItemType = Boolean(
    item?.itemType === 'journalArticle' &&
      (item?.publicationTitle ||
        meta.publicationTitle ||
        meta.journal ||
        (existingEngine && resolveProviderFieldWeight(existingEngine, 'itemType') >= 0.85)),
  );
  if (hasAuthoritativeJournalItemType) return false;
  if (!fieldProvenance.itemType) return true;
  return ItemProvenancePolicy.canOverwriteField(meta, 'itemType', 'LocalPDFExtraction', {
    hasNonEmptyExisting: Boolean(item?.itemType),
  });
}

export function buildExtractedMetadataSyncPlan(
  attachment: ExtractionSyncAttachmentInput,
  doc: ExtractionSyncDocumentInput,
) {
  const currentTitle = String(attachment.item?.title || '').trim();
  const cleanedExtractedTitle = doc.metadata?.title
    ? sanitizeItemTitle(doc.metadata.title) || doc.metadata.title.trim()
    : undefined;
  const cleanedExtractedAbstract = doc.metadata?.abstract
    ? cleanAbstractText(doc.metadata.abstract) ?? doc.metadata.abstract.trim()
    : undefined;

  const existingMeta = asMetaRecord(attachment.item?.metadata);
  const { provenanceMap: existingFieldProv } =
    ItemProvenancePolicy.extractProvenanceState(attachment.item ?? existingMeta);
  const lockedSet = ItemProvenancePolicy.expandLockedFieldSet(attachment.item ?? existingMeta);
  const isLocked = (fieldKey: string) =>
    lockedSet.has(fieldKey) ||
    ItemProvenancePolicy.isFieldLocked(attachment.item ?? existingMeta, fieldKey);
  const isCurrentFilenameTitle = Boolean(
    existingMeta.isFilenameTitle === true ||
      (attachment.item as Record<string, unknown> | undefined)?.isFilenameTitle === true ||
      (existingFieldProv.title as Record<string, unknown> | undefined)?.isFilenameTitle === true,
  );
  const shouldUpdateTitle = Boolean(
    cleanedExtractedTitle && (isPlaceholderItemTitle(currentTitle) || isCurrentFilenameTitle),
  );

  const metaPatch: Record<string, unknown> = {};
  if (doc.references && doc.references.length > 0) {
    metaPatch.referenceCount = doc.references.length;
  }
  if (doc.metadata?.arxivId && !existingMeta.arxivId && !isLocked('arxivId')) {
    metaPatch.arxivId = doc.metadata.arxivId;
  }

  const backfillKeys = [
    'isbn', 'issn', 'pmid', 'pmcid', 'volume', 'issue', 'pages', 'publisher',
    'place', 'conferenceName', 'bookTitle', 'publicationDate', 'numberOfPages', 'primaryCategory',
  ] as const;
  for (const key of backfillKeys) {
    const val = doc.metadata?.[key];
    if (
      !isLocked(key) &&
      val !== undefined &&
      val !== null &&
      val !== '' &&
      (existingMeta[key] === undefined || existingMeta[key] === null || existingMeta[key] === '')
    ) {
      metaPatch[key] = val;
    }
  }

  const fallbackPubTitle =
    doc.metadata?.publicationTitle ||
    doc.metadata?.journal ||
    doc.metadata?.proceedingsTitle ||
    doc.metadata?.conferenceName ||
    doc.metadata?.bookTitle ||
    (doc.metadata?.arxivId ? 'arXiv' : undefined);

  const canOverwriteItemType = canExtractionOverwriteItemType(
    attachment.item,
    existingMeta,
    lockedSet,
    existingFieldProv,
  );
  const existingDoi = String(attachment.item?.doi || existingMeta.doi || '').trim();
  const hasNonArxivPublisherDoi = Boolean(existingDoi && !/^10\.48550\/arxiv\./i.test(existingDoi));
  const shouldInferItemType =
    canOverwriteItemType &&
    (!attachment.item?.itemType ||
      attachment.item?.itemType === 'journalArticle' ||
      attachment.item?.itemType === 'document');
  const pdfSignalInference = shouldInferItemType
    ? inferItemTypeFromPdfSignals({
        title: cleanedExtractedTitle || doc.metadata?.title || attachment.item?.title,
        notes: doc.metadata?.notes,
        conferenceName: doc.metadata?.conferenceName || doc.metadata?.proceedingsTitle,
        bookTitle: doc.metadata?.bookTitle,
        isbn: doc.metadata?.isbn,
        publisher: doc.metadata?.publisher,
        journal: doc.metadata?.journal || doc.metadata?.publicationTitle,
      })
    : undefined;
  const rawInferredItemType =
    doc.metadata?.proceedingsTitle || doc.metadata?.conferenceName
      ? 'conferencePaper'
      : doc.metadata?.arxivId && !doc.metadata?.journal && !doc.metadata?.proceedingsTitle
        ? 'preprint'
        : pdfSignalInference?.itemType;
  const inferredItemType =
    rawInferredItemType === 'preprint' && hasNonArxivPublisherDoi ? undefined : rawInferredItemType;
  const effectiveItemType =
    shouldInferItemType && inferredItemType
      ? inferredItemType
      : String(attachment.item?.itemType || 'journalArticle');

  if (shouldInferItemType && inferredItemType) {
    metaPatch.itemType = inferredItemType;
    if (inferredItemType === 'preprint' && !isLocked('repository')) {
      metaPatch.repository =
        doc.metadata?.publicationTitle || doc.metadata?.journal || existingMeta.repository || 'arXiv';
    } else if (
      inferredItemType === 'conferencePaper' &&
      !existingMeta.proceedingsTitle &&
      !isLocked('proceedingsTitle')
    ) {
      metaPatch.proceedingsTitle =
        doc.metadata?.proceedingsTitle || doc.metadata?.conferenceName || fallbackPubTitle;
    }
  }

  const existingItemRecord = (attachment.item ?? {}) as Record<string, unknown>;
  const existingItemMeta = asMetaRecord(existingItemRecord.metadata);

  const idNormalizers = {
    arxivId: normalizeArxivId,
    pmid: normalizePmid,
    pmcid: normalizePmcid,
    isbn: normalizeIsbn,
    issn: normalizeIssn,
  } as const;
  const extractedIdentifiers: Array<{ type: string; value: string; canonicalUri: string }> = [];
  const cleanExtractedDoi = doc.metadata?.doi
    ? normalizeDoi(doc.metadata.doi) || doc.metadata.doi
    : undefined;
  if (cleanExtractedDoi && !attachment.item?.doi && !isLocked('doi')) {
    metaPatch.doi = cleanExtractedDoi;
    extractedIdentifiers.push({
      type: 'doi',
      value: cleanExtractedDoi,
      canonicalUri: `https://doi.org/${cleanExtractedDoi}`,
    });
  }
  const effectiveUpdateTitle = shouldUpdateTitle && !isLocked('title');
  if (effectiveUpdateTitle && cleanedExtractedTitle) {
    metaPatch.title = cleanedExtractedTitle;
    metaPatch.isFilenameTitle = false;
  }

  let hasBackfilledFields = Object.keys(metaPatch).length > 0;
  for (const idKey of ['arxivId', 'pmid', 'pmcid', 'isbn', 'issn'] as const) {
    const extractedVal = doc.metadata?.[idKey];
    if (!isLocked(idKey) && extractedVal && !existingItemMeta[idKey] && !existingItemRecord[idKey]) {
      const normVal = idNormalizers[idKey](extractedVal) || extractedVal;
      metaPatch[idKey] = normVal;
      hasBackfilledFields = true;
      const uriMap: Record<typeof idKey, string> = {
        arxivId: `https://arxiv.org/abs/${normVal}`,
        pmid: `https://pubmed.ncbi.nlm.nih.gov/${normVal}/`,
        pmcid: `https://www.ncbi.nlm.nih.gov/pmc/articles/${normVal}/`,
        isbn: `urn:isbn:${normVal}`,
        issn: `urn:issn:${normVal}`,
      };
      extractedIdentifiers.push({
        type: idKey === 'arxivId' ? 'arxiv' : idKey,
        value: normVal,
        canonicalUri: uriMap[idKey],
      });
    }
  }

  if (
    !isLocked('abstract') &&
    !isLocked('abstractNote') &&
    !attachment.item?.abstract &&
    cleanedExtractedAbstract &&
    !existingItemMeta.abstractNote
  ) {
    metaPatch.abstractNote = cleanedExtractedAbstract;
    hasBackfilledFields = true;
  }
  if (
    !isLocked('publicationTitle') &&
    !attachment.item?.publicationTitle &&
    fallbackPubTitle &&
    !existingItemMeta.publicationTitle
  ) {
    metaPatch.publicationTitle = fallbackPubTitle;
    if (
      effectiveItemType === 'conferencePaper' &&
      !existingItemMeta.proceedingsTitle &&
      !isLocked('proceedingsTitle')
    ) {
      metaPatch.proceedingsTitle = doc.metadata?.proceedingsTitle || fallbackPubTitle;
    }
    hasBackfilledFields = true;
  }
  if (
    !isLocked('year') &&
    !isLocked('date') &&
    !isLocked('publicationDate') &&
    !attachment.item?.year &&
    doc.metadata?.year &&
    !existingItemMeta.date &&
    !existingItemMeta.publicationDate
  ) {
    const resolvedDate = doc.metadata.publicationDate || String(doc.metadata.year);
    metaPatch.date = resolvedDate;
    metaPatch.publicationDate = resolvedDate;
    hasBackfilledFields = true;
  }

  const primaryRole = getPrimaryCreatorRoleForType(effectiveItemType);
  const creatorsToSync =
    isLocked('creators') || isLocked('authors')
      ? []
      : doc.metadata?.creators && doc.metadata.creators.length > 0
        ? doc.metadata.creators
        : doc.metadata?.authors && doc.metadata.authors.length > 0
          ? doc.metadata.authors.map((name: string) => ({ fullName: name }))
          : [];
  const tagsToSync =
    !isLocked('tags') && Array.isArray(doc.metadata?.keywords) ? doc.metadata.keywords : [];
  const notesToSync = Array.isArray(doc.metadata?.notes) ? doc.metadata.notes : [];

  const docFieldProv = doc.metadata?.fieldProvenance;
  const resolveTierProv = (fieldKey: string) => {
    const coupled = ItemProvenancePolicy.getCoupledFieldAliases(fieldKey);
    const tier = docFieldProv?.[fieldKey] ?? coupled.map((a) => docFieldProv?.[a]).find(Boolean);
    const src = tier?.source || 'LocalPDFExtraction';
    const conf = typeof tier?.confidence === 'number' ? tier.confidence : 0.82;
    return {
      source: src,
      sourceProvider: src,
      confidence: conf,
      verified: conf >= 0.8,
      ...(tier?.extractedAt ? { retrievedAt: tier.extractedAt } : {}),
      ...(fieldKey === 'title' ? { isFilenameTitle: false } : {}),
    };
  };

  const existingCitKey = String(existingItemRecord.citationKey || '').trim();
  const needsCitationKeyRegen =
    !isLocked('citationKey') && (!existingCitKey || /^anon/i.test(existingCitKey));
  const resolvedTitle = effectiveUpdateTitle ? cleanedExtractedTitle : currentTitle;
  const resolvedYear = (attachment.item?.year as number | undefined) || doc.metadata?.year;
  const firstCreatorCandidate = creatorsToSync[0];
  const cand = firstCreatorCandidate as Record<string, unknown> | undefined;
  const firstCreatorRaw = cand
    ? (typeof cand.lastName === 'string' && cand.lastName) ||
      (typeof cand.fullName === 'string' && cand.fullName) ||
      (typeof cand.name === 'string' && cand.name) ||
      ''
    : '';
  const regeneratedCitKey =
    needsCitationKeyRegen && (effectiveUpdateTitle || firstCreatorRaw || resolvedYear)
      ? generateCitationKey({
          authors: firstCreatorRaw ? [firstCreatorRaw] : undefined,
          year: resolvedYear ?? null,
          title: resolvedTitle || 'Untitled',
        })
      : undefined;
  if (regeneratedCitKey && !/^anon/i.test(regeneratedCitKey)) {
    metaPatch.citationKey = regeneratedCitKey;
    hasBackfilledFields = true;
  }

  if (hasBackfilledFields || creatorsToSync.length > 0 || tagsToSync.length > 0) {
    if (hasBackfilledFields) {
      const harmonizedDelta = harmonizeZoteroFields(
        { ...metaPatch, itemType: effectiveItemType },
        { itemType: effectiveItemType, syncExtraFields: false, syncLegacyAliases: false },
      );
      for (const [k, v] of Object.entries(harmonizedDelta)) {
        if (isLocked(k)) continue;
        if (k === 'itemType' && metaPatch.itemType === undefined) continue;
        if (k === 'abstract' && metaPatch.abstractNote !== undefined && metaPatch.abstract === undefined) {
          continue;
        }
        if (k === 'numPages' && metaPatch.numberOfPages !== undefined && metaPatch.numPages === undefined) {
          continue;
        }
        if (k === 'archiveId' && metaPatch.arxivId !== undefined && metaPatch.archiveId === undefined) {
          continue;
        }
        if (
          v !== undefined &&
          metaPatch[k] === undefined &&
          (existingItemMeta[k] === undefined || existingItemMeta[k] === null || existingItemMeta[k] === '')
        ) {
          metaPatch[k] = v;
        }
      }
    }
    const nextProv: Record<string, unknown> = { ...existingFieldProv };
    for (const patchedKey of Object.keys(metaPatch)) {
      if (
        patchedKey === 'referenceCount' ||
        patchedKey === 'fieldProvenance' ||
        patchedKey === 'lockedFields' ||
        patchedKey === 'isFilenameTitle'
      ) {
        continue;
      }
      if (!nextProv[patchedKey] || (patchedKey === 'title' && effectiveUpdateTitle)) {
        nextProv[patchedKey] = resolveTierProv(patchedKey);
      }
    }
    if (creatorsToSync.length > 0) {
      if (!nextProv.creators) nextProv.creators = resolveTierProv('creators');
      if (!nextProv.authors) nextProv.authors = resolveTierProv('authors');
    }
    if (tagsToSync.length > 0) {
      if (!nextProv.tags) nextProv.tags = resolveTierProv('tags');
      if (!nextProv.keywords) nextProv.keywords = resolveTierProv('keywords');
    }
    metaPatch.fieldProvenance = nextProv;
    hasBackfilledFields = true;
  }

  const { tags: _omitTags, keywords: _omitKeywords, ...existingItemMetaWithoutTags } = existingItemMeta;
  const itemPatch: Prisma.ItemUpdateInput = {
    ...(shouldInferItemType && inferredItemType ? { itemType: inferredItemType } : {}),
    ...(effectiveUpdateTitle ? { title: cleanedExtractedTitle } : {}),
    ...(regeneratedCitKey && !/^anon/i.test(regeneratedCitKey) ? { citationKey: regeneratedCitKey } : {}),
    ...(!isLocked('doi') && !attachment.item?.doi && cleanExtractedDoi ? { doi: cleanExtractedDoi } : {}),
    ...(!isLocked('abstract') && !isLocked('abstractNote') && !attachment.item?.abstract && cleanedExtractedAbstract
      ? { abstract: cleanedExtractedAbstract }
      : {}),
    ...(!isLocked('year') && !isLocked('date') && !isLocked('publicationDate') && !attachment.item?.year && doc.metadata?.year
      ? { year: doc.metadata.year }
      : {}),
    ...(!isLocked('publicationTitle') && !isLocked('journal') && !attachment.item?.publicationTitle && fallbackPubTitle
      ? { publicationTitle: fallbackPubTitle }
      : {}),
    ...(hasBackfilledFields
      ? { metadata: { ...existingItemMetaWithoutTags, ...metaPatch } as unknown as Prisma.InputJsonValue }
      : {}),
  };

  return {
    itemPatch,
    metaPatch,
    extractedIdentifiers,
    creatorsToSync,
    primaryRole,
    tagsToSync,
    notesToSync,
  };
}

export async function sanitizeExtractedItemUpdateAgainstFreshState(params: {
  data: Prisma.ItemUpdateInput;
  freshItem: FreshItemExtractionTarget | null;
  resolveCitationKey?: (candidateKey: string) => Promise<string | null>;
}): Promise<{
  sanitizedData: Prisma.ItemUpdateInput;
  mergedMetadata: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined;
}> {
  const { data, freshItem, resolveCitationKey } = params;
  const sanitizedData: Prisma.ItemUpdateInput = { ...data };
  let disambiguatedCitKey: string | undefined;

  const freshestMeta = asMetaRecord(freshItem?.metadata);
  const { provenanceMap: freshFieldProv } =
    ItemProvenancePolicy.extractProvenanceState(freshestMeta);
  const freshLockedSet = ItemProvenancePolicy.expandLockedFieldSet(freshestMeta);

  const cannotOverwriteItemType = !canExtractionOverwriteItemType(
    freshItem,
    freshestMeta,
    freshLockedSet,
    freshFieldProv,
  );
  const isFreshFilenameTitle = Boolean(
    freshestMeta.isFilenameTitle === true ||
      (freshFieldProv.title as Record<string, unknown> | undefined)?.isFilenameTitle === true,
  );

  if (freshItem) {
    const isFreshPlaceholder = isPlaceholderItemTitle(freshItem.title) || isFreshFilenameTitle;
    if (sanitizedData.title !== undefined && (!isFreshPlaceholder || freshLockedSet.has('title'))) {
      delete sanitizedData.title;
    }
    if (sanitizedData.doi !== undefined && (freshItem.doi || freshLockedSet.has('doi'))) {
      delete sanitizedData.doi;
    }
    if (
      sanitizedData.abstract !== undefined &&
      (freshItem.abstract || freshLockedSet.has('abstract') || freshLockedSet.has('abstractNote'))
    ) {
      delete sanitizedData.abstract;
    }
    if (sanitizedData.year !== undefined && (freshItem.year || freshLockedSet.has('year'))) {
      delete sanitizedData.year;
    }
    if (
      sanitizedData.publicationTitle !== undefined &&
      (freshItem.publicationTitle || freshLockedSet.has('publicationTitle'))
    ) {
      delete sanitizedData.publicationTitle;
    }
    if (sanitizedData.itemType !== undefined && cannotOverwriteItemType) {
      delete sanitizedData.itemType;
    }
    const freshCitKey = String(freshItem.citationKey || '').trim();
    if (sanitizedData.citationKey !== undefined) {
      if (freshLockedSet.has('citationKey') || (freshCitKey && !/^anon/i.test(freshCitKey))) {
        delete sanitizedData.citationKey;
      } else if (typeof sanitizedData.citationKey === 'string' && sanitizedData.citationKey.trim()) {
        const candidateKey = sanitizedData.citationKey.trim();
        disambiguatedCitKey = resolveCitationKey
          ? ((await resolveCitationKey(candidateKey)) ?? undefined)
          : candidateKey;
        sanitizedData.citationKey = disambiguatedCitKey;
      }
    }
  }

  let mergedMetadata = sanitizedData.metadata;
  if (
    sanitizedData.metadata &&
    typeof sanitizedData.metadata === 'object' &&
    !Array.isArray(sanitizedData.metadata)
  ) {
    const isFreshMetaTitlePlaceholder =
      isPlaceholderItemTitle(freshestMeta.title) ||
      isPlaceholderItemTitle(freshItem?.title) ||
      isFreshFilenameTitle;
    const incomingMeta = { ...(sanitizedData.metadata as Record<string, unknown>) };
    const incomingFieldProv =
      incomingMeta.fieldProvenance &&
      typeof incomingMeta.fieldProvenance === 'object' &&
      !Array.isArray(incomingMeta.fieldProvenance)
        ? (incomingMeta.fieldProvenance as Record<string, unknown>)
        : undefined;
    delete incomingMeta.fieldProvenance;

    const acceptedKeys = new Set<string>(['creators', 'authors', 'tags', 'keywords']);
    if (sanitizedData.title !== undefined) acceptedKeys.add('title');
    if (sanitizedData.itemType !== undefined) acceptedKeys.add('itemType');

    const freshCitKey = String(freshItem?.citationKey || '').trim();
    if (freshLockedSet.has('citationKey') || (freshCitKey && !/^anon/i.test(freshCitKey))) {
      delete incomingMeta.citationKey;
    } else if (disambiguatedCitKey) {
      incomingMeta.citationKey = disambiguatedCitKey;
    }

    const hasNonEmptyCol = (val: unknown): boolean =>
      val !== undefined && val !== null && String(val).trim() !== '';
    const hasFreshAbstract =
      hasNonEmptyCol(freshItem?.abstract) ||
      hasNonEmptyCol(freshestMeta.abstract) ||
      hasNonEmptyCol(freshestMeta.abstractNote);
    const hasFreshYearOrDate =
      hasNonEmptyCol(freshItem?.year) ||
      hasNonEmptyCol(freshestMeta.year) ||
      hasNonEmptyCol(freshestMeta.date) ||
      hasNonEmptyCol(freshestMeta.publicationDate);
    const hasFreshPubTitle =
      hasNonEmptyCol(freshItem?.publicationTitle) ||
      hasNonEmptyCol(freshestMeta.publicationTitle) ||
      hasNonEmptyCol(freshestMeta.journal);
    const hasFreshDoi = hasNonEmptyCol(freshItem?.doi) || hasNonEmptyCol(freshestMeta.doi);

    for (const [k, v] of Object.entries(incomingMeta)) {
      const hasFreshVal =
        (freshestMeta[k] !== undefined &&
          freshestMeta[k] !== null &&
          freshestMeta[k] !== '' &&
          !(Array.isArray(freshestMeta[k]) && (freshestMeta[k] as unknown[]).length === 0)) ||
        ((k === 'abstract' || k === 'abstractNote') && hasFreshAbstract) ||
        ((k === 'year' || k === 'date' || k === 'publicationDate') && hasFreshYearOrDate) ||
        ((k === 'publicationTitle' || k === 'journal') && hasFreshPubTitle) ||
        (k === 'doi' && hasFreshDoi);

      const isAllowedTitleOverride =
        (k === 'title' && isFreshMetaTitlePlaceholder) ||
        (k === 'isFilenameTitle' && isFreshMetaTitlePlaceholder && !freshLockedSet.has('title'));
      const isAllowedAnonCitationKeyOverride =
        k === 'citationKey' &&
        (!freshestMeta.citationKey || /^anon/i.test(String(freshestMeta.citationKey)));

      if (
        freshLockedSet.has(k) ||
        ItemProvenancePolicy.isFieldLocked(freshestMeta, k) ||
        (k === 'itemType' && cannotOverwriteItemType) ||
        (k !== 'referenceCount' &&
          !isAllowedTitleOverride &&
          !isAllowedAnonCitationKeyOverride &&
          hasFreshVal)
      ) {
        if (freshestMeta[k] !== undefined) {
          incomingMeta[k] = freshestMeta[k];
        } else {
          delete incomingMeta[k];
        }
      } else {
        incomingMeta[k] = v;
        acceptedKeys.add(k);
      }
    }

    if (incomingFieldProv || Object.keys(freshFieldProv).length > 0) {
      const mergedProv: Record<string, unknown> = { ...freshFieldProv };
      if (incomingFieldProv) {
        for (const [pk, pv] of Object.entries(incomingFieldProv)) {
          if (!freshFieldProv[pk] || acceptedKeys.has(pk)) {
            mergedProv[pk] = pv;
          }
        }
      }
      incomingMeta.fieldProvenance = mergedProv;
    }

    mergedMetadata = {
      ...freshestMeta,
      ...incomingMeta,
    } as Prisma.InputJsonValue;
  }

  return { sanitizedData, mergedMetadata };
}

export async function disambiguateCitationKey(
  client:
    | Prisma.TransactionClient
    | { item?: { findMany?: Prisma.TransactionClient['item']['findMany'] } }
    | null
    | undefined,
  baseKey: string | null | undefined,
  scope: { userId: string; projectId?: string | null },
  excludeItemId?: string,
): Promise<string | null> {
  if (!baseKey || !baseKey.trim()) return null;
  const cleanKey = baseKey.trim();
  if (typeof client?.item?.findMany !== 'function') return cleanKey;
  const scopeWhere: Prisma.ItemWhereInput =
    scope.projectId && isUuid(scope.projectId)
      ? { projectId: scope.projectId }
      : { userId: scope.userId, projectId: null };
  const rows = await client.item.findMany({
    where: {
      ...scopeWhere,
      deletedAt: null,
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
      citationKey: { startsWith: cleanKey, mode: 'insensitive' },
    },
    select: { citationKey: true },
    take: 500,
  });
  const existingKeys = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((item: { citationKey?: string | null }) => item.citationKey?.toLowerCase())
      .filter((k: string | undefined): k is string => Boolean(k)),
  );
  if (!existingKeys.has(cleanKey.toLowerCase())) return cleanKey;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < alphabet.length; i++) {
    const candidate = `${cleanKey}${alphabet[i]}`;
    if (!existingKeys.has(candidate.toLowerCase())) return candidate;
  }
  let counter = 1;
  while (existingKeys.has(`${cleanKey}-${counter}`.toLowerCase())) counter++;
  return `${cleanKey}-${counter}`;
}

export async function resolveOrCreateTags(
  client: Prisma.TransactionClient,
  userId: string,
  rawTagList: (string | null | undefined)[],
  defaultTagType: TagType = TagType.automatic,
  projectId?: string | null,
): Promise<Array<{ id: string; type: TagType }>> {
  const normalizedTagNames = normalizeAcademicTags(rawTagList).slice(0, 500);
  if (normalizedTagNames.length === 0) return [];
  const effectiveProjectId =
    projectId && projectId !== 'user' && projectId !== 'me' && projectId !== 'personal' && isUuid(projectId)
      ? projectId
      : null;
  const scopeWhere: Prisma.TagWhereInput = effectiveProjectId ? { projectId: effectiveProjectId } : { userId, projectId: null };
  const tagOrFilter = normalizedTagNames.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } }));
  const preExistingTags = (await client.tag.findMany({ where: { ...scopeWhere, OR: tagOrFilter }, select: { id: true, name: true, type: true } })) || [];
  const existingLowerNames = new Set(
    preExistingTags.map((t: { id: string; name?: string }) => (typeof t.name === 'string' ? t.name.toLowerCase() : '')).filter(Boolean),
  );
  const seenMissingLower = new Set<string>();
  const missingTagNames = normalizedTagNames.filter((name) => {
    const lower = name.toLowerCase();
    if (existingLowerNames.has(lower) || seenMissingLower.has(lower)) return false;
    seenMissingLower.add(lower);
    return true;
  });
  if (missingTagNames.length > 0) {
    if (typeof client.tag.createMany === 'function') {
      await client.tag.createMany({
        data: missingTagNames.map((name) => ({ userId, createdById: userId, name, type: defaultTagType, projectId: effectiveProjectId })),
        skipDuplicates: true,
      });
    } else {
      for (const name of missingTagNames) {
        try {
          await client.tag.create({ data: { userId, createdById: userId, name, type: defaultTagType, projectId: effectiveProjectId } });
        } catch {
          // Concurrent creation
        }
      }
    }
  }
  const allMatchingTags =
    missingTagNames.length > 0
      ? (await client.tag.findMany({ where: { ...scopeWhere, OR: tagOrFilter }, select: { id: true, name: true, type: true } })) || preExistingTags
      : preExistingTags;
  const dedupedByLower = new Map<string, { id: string; type: TagType }>();
  for (const t of allMatchingTags as Array<{ id: string; name?: string; type?: TagType }>) {
    const key = typeof t.name === 'string' ? t.name.toLowerCase() : t.id;
    if (!dedupedByLower.has(key)) dedupedByLower.set(key, { id: t.id, type: t.type || defaultTagType });
  }
  return Array.from(dedupedByLower.values());
}
