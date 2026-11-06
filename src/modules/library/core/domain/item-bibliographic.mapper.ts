import { cleanAbstractText } from './text.domain';
import { isInstitutionName, splitAuthorString } from './author.domain';
import { resolveCanonicalArxivCategory } from './tag.domain';
import { CANONICAL_IDENTIFIER_URI_BUILDERS } from './identifier.domain';
import { isRejectedCitedIdentifier } from './metadata-coalesce.policy';
import { ItemProvenancePolicy } from './item-provenance.domain';
import {
  getEffectiveBaseFieldMap,
  getPrimaryCreatorRoleForType,
  resolveBidirectionalBaseFields,
  resolveCanonicalCreatorRole,
  resolveFieldAliases,
} from './field-harmonizer.domain';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
  type AttachmentLike,
  type CreatorCreditInput,
  type ItemIdentifierLike,
  type MutableItemPayload,
} from '../types/bibliographic.types';

export type { AttachmentLike, ItemIdentifierLike, MutableItemPayload };

export function parseJsonObject(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  if (typeof val === 'string' && val.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(val.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function toStr(val: unknown): string {
  return typeof val === 'string' || typeof val === 'number' ? String(val) : '';
}

export function mapCreatorsPartial(it: MutableItemPayload): void {
  const rawStructured =
    Array.isArray(it.contributors) && it.contributors.length > 0
      ? it.contributors
      : Array.isArray(it.creators) && it.creators.length > 0
        ? it.creators
        : null;

  if (rawStructured) {
    it.creators = rawStructured.map((c: CreatorCreditInput, idx: number) => {
      const full =
        c.fullName ||
        [c.firstName, c.lastName].filter(Boolean).join(' ') ||
        c.name ||
        '';
      const rawFieldMode = (c as { fieldMode?: number }).fieldMode;
      const inferredFieldMode =
        rawFieldMode === 1
          ? 1
          : rawFieldMode === 0 && (c.firstName || !isInstitutionName(full))
            ? 0
            : !c.firstName && isInstitutionName(full)
              ? 1
              : 0;
      return {
        id: (c as { id?: string }).id,
        orderIndex: c.orderIndex ?? idx,
        creatorType: resolveCanonicalCreatorRole(c.creatorType, {
          itemType: it.itemType,
        }),
        fieldMode: inferredFieldMode,
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
        shortName: (c as { shortName?: string }).shortName || undefined,
        fullName: full,
        name: full,
      };
    });
  } else if (Array.isArray(it.authors) && it.authors.length > 0) {
    it.creators = (it.authors as string[]).map((name: string, idx: number) => ({
      orderIndex: idx,
      creatorType: 'author',
      fullName: name,
      name,
    }));
  } else {
    it.creators = [];
  }

  if (Array.isArray(it.creators) && it.creators.length > 0) {
    const primaryRole = getPrimaryCreatorRoleForType(it.itemType);
    const primaryCreators = it.creators.filter((c: CreatorCreditInput) => {
      const role = c.creatorType || 'author';
      return role === 'author' || role === primaryRole;
    });
    it.authors = primaryCreators
      .map(
        (c: CreatorCreditInput) =>
          c.fullName ||
          c.name ||
          [c.firstName, c.lastName].filter(Boolean).join(' '),
      )
      .filter(Boolean);
  } else if (Array.isArray(it.authors) && it.authors.length > 0) {
    it.authors = (it.authors as string[]).flatMap((a: string) =>
      splitAuthorString(a),
    );
  } else {
    it.authors = [];
  }

  it.editors = (it.creators || [])
    .filter((c: CreatorCreditInput) => c.creatorType === 'editor')
    .map((c: CreatorCreditInput) => c.fullName || c.name || '')
    .filter(Boolean);
}

export function harmonizeDomainMetadataAndIdentifiersPartial(
  it: MutableItemPayload,
): void {
  const extraFields = it.extraFields || {};

  const parsePositiveIntOrNull = (
    val: unknown,
    fallback: unknown,
  ): number | null => {
    const candidate =
      val === undefined || val === null || val === 0 || val === '0'
        ? fallback
        : val;
    const num = candidate ? Number(candidate) : null;
    return num && num > 0 ? num : null;
  };

  it.citationCount = parsePositiveIntOrNull(
    it.citationCount,
    extraFields.citationCount,
  );
  it.referenceCount = parsePositiveIntOrNull(
    it.referenceCount,
    extraFields.referenceCount,
  );
  if (!it.openAccessPdfUrl) {
    it.openAccessPdfUrl =
      (extraFields.openAccessPdfUrl as string | null | undefined) ?? null;
  }
  if (!it.arxivId) {
    it.arxivId =
      (extraFields.arxivId as string | null | undefined) ??
      (extraFields.archiveId as string | null | undefined) ??
      null;
  }

  if (
    !it.proceedingsTitle &&
    (extraFields.proceedingsTitle ||
      (it.itemType === 'conferencePaper' && it.publicationTitle))
  ) {
    it.proceedingsTitle = toStr(
      extraFields.proceedingsTitle || it.publicationTitle,
    );
  }
  if (
    !it.conferenceName &&
    extraFields.conferenceName &&
    extraFields.conferenceName !== it.proceedingsTitle &&
    extraFields.conferenceName !== it.publicationTitle
  ) {
    it.conferenceName = toStr(extraFields.conferenceName);
  }

  if (
    it.abstract ||
    it.abstractNote ||
    extraFields.abstract ||
    extraFields.abstractNote
  ) {
    const rawAbstract = toStr(
      it.abstract ||
        it.abstractNote ||
        extraFields.abstract ||
        extraFields.abstractNote,
    );
    it.abstract =
      cleanAbstractText(rawAbstract) ??
      (it.abstract || it.abstractNote || null);
  }
  it.abstractNote = it.abstract ?? null;

  if (
    it.year !== undefined &&
    it.year !== null &&
    (it.year === 0 || String(it.year) === '0' || Number(it.year) <= 0)
  ) {
    it.year = null;
  }
  it.date = it.date || it.publicationDate || (it.year ? String(it.year) : null);
  if (it.date === '0' || it.date === '0000') {
    it.date = null;
  }

  for (const field of ['volume', 'issue', 'pages', 'edition'] as const) {
    if (it[field] !== undefined && it[field] !== null) {
      const str = toStr(it[field]).trim();
      it[field] =
        str === '' || (field === 'edition' && str === '0') ? null : str;
    }
  }

  const normalizePageCount = (val: unknown): number | string | null => {
    if (val === undefined || val === null) return null;
    const str = toStr(val).trim();
    if (str === '0' || str === '') return null;
    const num = Number(str);
    return isNaN(num) ? str : num > 0 ? num : null;
  };
  if (it.numPages !== undefined) it.numPages = normalizePageCount(it.numPages);
  if (it.numberOfPages !== undefined) {
    it.numberOfPages = normalizePageCount(it.numberOfPages);
  }

  if (it.callNumber && /^arxiv:\s*\d{4}\.\d{4,5}/i.test(toStr(it.callNumber))) {
    if (!it.arxivId) {
      it.arxivId = toStr(it.callNumber)
        .replace(/^arxiv:\s*/i, '')
        .trim();
    }
    it.callNumber = null;
  }

  if (it.arxivId || it.archiveId) {
    const rawId = toStr(it.arxivId || it.archiveId);
    const cleanArxivId = rawId
      .replace(/^arxiv:\s*/i, '')
      .replace(/\s*\[.*?\]\s*$/, '')
      .trim();
    it.arxivId = cleanArxivId;
    const canonicalCleanId = cleanArxivId.replace(/v\d+$/i, '');
    if (it.itemType === 'preprint') {
      it.archiveId = `arXiv:${canonicalCleanId}`;
    }

    const existingExtra = typeof it.extra === 'string' ? it.extra.trim() : '';
    const catStr = resolveCanonicalArxivCategory(
      canonicalCleanId,
      Array.isArray(it.tags) ? (it.tags as string[]) : undefined,
      extraFields,
      it,
    );

    const isPreprintOrArxivPrimary =
      it.itemType === 'preprint' ||
      !it.doi ||
      /^10\.48550\/arxiv\./i.test(String(it.doi));
    if (isPreprintOrArxivPrimary && !existingExtra.toLowerCase().includes('arxiv:')) {
      const arxivLine = catStr
        ? `arXiv: ${canonicalCleanId} [${catStr}]`
        : `arXiv: ${canonicalCleanId}`;
      it.extra = existingExtra ? `${arxivLine}\n${existingExtra}` : arxivLine;
    } else if (existingExtra.toLowerCase().includes('arxiv:')) {
      it.extra = existingExtra.replace(
        /^arxiv:\s*([^\s[]+)(?:v\d+)?(?:\s*\[([^\]]+)\])?/im,
        (_: string, id: string, cat?: string) => {
          const canonicalId = id.replace(/v\d+$/i, '').trim();
          const finalCat = (cat ? cat.trim() : '') || catStr;
          return finalCat
            ? `arXiv: ${canonicalId} [${finalCat}]`
            : `arXiv: ${canonicalId}`;
        },
      );
    }
  }

  const baseMap = it.itemType
    ? getEffectiveBaseFieldMap(it.itemType)
    : undefined;
  resolveBidirectionalBaseFields(it, it.itemType, [it.extraFields], false);
  resolveFieldAliases(it, [it.extraFields]);

  if (baseMap) {
    for (const [baseField, mappedField] of Object.entries(baseMap)) {
      if (!mappedField || mappedField === baseField) continue;
      if (baseField === 'type' || baseField === 'medium') {
        const currentSubtype =
          it.type && it.type.toLowerCase() !== (it.itemType || '').toLowerCase()
            ? it.type
            : undefined;
        it[mappedField] =
          it[mappedField] ||
          (baseField === 'medium' ? it.medium : undefined) ||
          currentSubtype ||
          '';
        if (baseField === 'type' && it[mappedField] && !currentSubtype) {
          it.type = it[mappedField] as string;
        }
        continue;
      }
      if (it[mappedField] === undefined || it[mappedField] === null) {
        it[mappedField] = '';
      }
      if (
        (it[baseField] === undefined || it[baseField] === null) &&
        baseField !== 'status' &&
        baseField !== 'authority' &&
        baseField !== 'originalDate' &&
        baseField !== 'number'
      ) {
        it[baseField] = '';
      }
    }
  }

  it.publicationTitle = it.publicationTitle ?? '';
  it.publisher = it.publisher ?? '';
  it.place = it.place ?? '';
  it.volume = it.volume ?? '';
  it.issue = it.issue ?? '';
  it.pages = it.pages ?? '';

  if (it.itemType === 'journalArticle' || !it.itemType) {
    it.journal = it.journal || it.publicationTitle || '';
    it.publicationTitle = it.publicationTitle || it.journal || '';
  }

  if (it.itemType === 'preprint') {
    const isArxiv = Boolean(
      it.arxivId ||
      it.archiveId ||
      it.archiveID ||
      (it.doi && /arxiv/i.test(toStr(it.doi))) ||
      (it.publicationTitle && /arxiv/i.test(it.publicationTitle)) ||
      (it.publisher && /arxiv/i.test(toStr(it.publisher))),
    );
    it.genre = it.genre || it.type || 'Preprint';
    const cleanArxivNum = it.arxivId
      ? toStr(it.arxivId)
          .replace(/^arxiv:\s*/i, '')
          .replace(/v\d+$/i, '')
          .trim()
      : '';
    it.archiveId =
      it.archiveId ||
      it.archiveID ||
      (cleanArxivNum ? `arXiv:${cleanArxivNum}` : '') ||
      '';
    delete it.archiveID;
    const hadExplicitPubTitle = Boolean(
      it.publicationTitle && toStr(it.publicationTitle).trim(),
    );
    const hadExplicitPublisher = Boolean(
      it.publisher && toStr(it.publisher).trim(),
    );
    it.repository =
      it.repository ||
      (hadExplicitPublisher ? toStr(it.publisher).trim() : '') ||
      (isArxiv ? 'arXiv' : '') ||
      it.publicationTitle ||
      '';
    it.publicationTitle = hadExplicitPubTitle ? it.publicationTitle : '';
    it.publisher = hadExplicitPublisher ? it.publisher : '';
    delete it.journal;
  } else if (it.itemType === 'thesis') {
    it.thesisType =
      it.thesisType ||
      (it.type && it.type.toLowerCase() !== 'thesis' ? it.type : undefined) ||
      it.genre ||
      '';
  } else if (it.itemType === 'patent') {
    it.issuingAuthority =
      it.issuingAuthority || it.authority || it.country || '';
    it.authority = it.authority || it.issuingAuthority || '';
    it.country = it.country || '';
    it.patentNumber = it.patentNumber || it.number || '';
    it.issueDate = it.issueDate || it.date || it.publicationDate || '';
    it.priorityDate = it.priorityDate || it.originalDate || '';
    it.assignee = it.assignee || '';
  }

  if (
    it.year === undefined ||
    it.year === null ||
    isNaN(Number(it.year)) ||
    Number(it.year) === 0
  ) {
    const dateCandidate =
      it.date ||
      it.publicationDate ||
      it.issueDate ||
      it.dateDecided ||
      it.dateEnacted ||
      it.filingDate;
    if (dateCandidate) {
      const yearMatch = toStr(dateCandidate).match(
        /(?:^|[^\d])(1\d{3}|20\d{2})(?:[^\d]|$)/,
      );
      if (yearMatch) {
        it.year = parseInt(yearMatch[1], 10);
      }
    }
  } else if (typeof it.year === 'string') {
    const parsedNum = parseInt(it.year, 10);
    it.year = isNaN(parsedNum) ? null : parsedNum;
  }

  it.publicationDate =
    it.publicationDate || it.date || (it.year ? String(it.year) : '');
  it.date = it.date || it.publicationDate || (it.year ? String(it.year) : '');

  const rejectedCitedDoi = extraFields.rejectedCitedDoi ?? it.rejectedCitedDoi;
  if (Array.isArray(it.identifiers)) {
    const idTypeToField: Record<string, keyof MutableItemPayload> = {
      arxiv: 'arxivId', arxivid: 'arxivId', doi: 'doi', pmid: 'pmid', pmcid: 'pmcid', isbn: 'isbn', issn: 'issn',
    };
    for (const ident of it.identifiers) {
      const type = (ident.type || ident.identifierType || '').trim().toLowerCase();
      const targetKey = idTypeToField[type];
      const cleanVal = typeof ident.value === 'string' ? ident.value.trim() : '';
      if (targetKey && cleanVal && Boolean(rejectedCitedDoi) && isRejectedCitedIdentifier(cleanVal, rejectedCitedDoi) && !ItemProvenancePolicy.inspectFieldUserLock(extraFields, String(targetKey)).locked) {
        continue;
      }
      const currentVal = targetKey && typeof it[targetKey] === 'string' ? (it[targetKey] as string).trim() : '';
      const isArxivDoiOverwritingPublishedDoi =
        targetKey === 'doi' && Boolean(currentVal) && !/^10\.48550\/arxiv\./i.test(currentVal) && /^10\.48550\/arxiv\./i.test(cleanVal);
      if (targetKey && cleanVal && !isArxivDoiOverwritingPublishedDoi) {
        it[targetKey] = cleanVal;
      }
    }
  }

  resolveFieldAliases(it, [extraFields], true);

  it.abstract = it.abstract || it.abstractNote || '';
  it.abstractNote = it.abstract;
  it.journalAbbreviation = it.journalAbbreviation || '';
  delete it.journalAbbr;
  it.accessDate =
    it.accessDate ||
    (it.accessedAt
      ? it.accessedAt instanceof Date
        ? it.accessedAt.toISOString()
        : toStr(it.accessedAt)
      : '');
  delete it.accessedAt;
  it.citationKey = it.citationKey || '';
  delete it.citeKey;
  it.url = it.url || '';
  delete it.URL;

  for (const [lowerKey, upperKey] of [
    ['doi', 'DOI'],
    ['isbn', 'ISBN'],
    ['issn', 'ISSN'],
    ['pmid', 'PMID'],
    ['pmcid', 'PMCID'],
  ] as const) {
    const canonicalVal = toStr(it[lowerKey] || it[upperKey]);
    it[lowerKey] = canonicalVal;
    it[upperKey] = canonicalVal;
  }

  const canonicalArxivId =
    it.arxivId ||
    it.archiveId ||
    it.archiveID ||
    extraFields.arxivId ||
    extraFields.archiveId ||
    extraFields.archiveID ||
    '';
  const cleanArxiv = canonicalArxivId
    ? toStr(canonicalArxivId)
        .replace(/^arxiv:\s*/i, '')
        .replace(/\s*\[.*?\]\s*$/, '')
        .trim()
    : '';
  it.arxivId = cleanArxiv;
  it.archiveId = cleanArxiv
    ? it.itemType === 'preprint'
      ? `arXiv:${cleanArxiv.replace(/v\d+$/i, '')}`
      : cleanArxiv
    : it.archiveId || it.archiveID || '';
  it.archiveID = it.archiveID || it.archiveId;

  if (it.extraFields && typeof it.extraFields === 'object') {
    for (const fieldKey of TYPE_SPECIFIC_EXTRA_FIELDS) {
      const topVal = it[fieldKey];
      if (
        topVal !== undefined &&
        topVal !== null &&
        topVal !== '' &&
        it.extraFields[fieldKey] === undefined
      ) {
        it.extraFields[fieldKey] = topVal;
      }
    }
    if (baseMap) {
      for (const mappedField of Object.values(baseMap)) {
        const topVal = it[mappedField];
        if (
          mappedField &&
          topVal !== undefined &&
          topVal !== null &&
          topVal !== '' &&
          !ITEM_COLUMN_METADATA_FIELDS.has(mappedField) &&
          it.extraFields[mappedField] === undefined
        ) {
          it.extraFields[mappedField] = topVal;
        }
      }
    }
  }

  const idDefs: ReadonlyArray<{
    type: string;
    val: string | null | undefined;
    uri: (v: string) => string;
  }> = [
    { type: 'doi', val: it.doi, uri: CANONICAL_IDENTIFIER_URI_BUILDERS.doi },
    { type: 'arxiv', val: it.arxivId, uri: CANONICAL_IDENTIFIER_URI_BUILDERS.arxiv },
    { type: 'pmid', val: it.pmid, uri: CANONICAL_IDENTIFIER_URI_BUILDERS.pmid },
    { type: 'pmcid', val: it.pmcid, uri: CANONICAL_IDENTIFIER_URI_BUILDERS.pmcid },
    { type: 'isbn', val: it.isbn, uri: CANONICAL_IDENTIFIER_URI_BUILDERS.isbn },
    { type: 'issn', val: it.issn, uri: CANONICAL_IDENTIFIER_URI_BUILDERS.issn },
  ];
  const existingIdents = Array.isArray(it.identifiers)
    ? it.identifiers.filter((ident) => {
        const val = typeof ident?.value === 'string' ? ident.value.trim() : '';
        const type = (ident?.type || ident?.identifierType || '').trim().toLowerCase();
        const lockField = type === 'arxiv' || type === 'arxivid' ? 'arxivId' : type || 'doi';
        return !(val && Boolean(rejectedCitedDoi) && isRejectedCitedIdentifier(val, rejectedCitedDoi) && !ItemProvenancePolicy.inspectFieldUserLock(extraFields, lockField).locked);
      })
    : [];
  const existingTypes = new Set(
    existingIdents
      .map((ident) =>
        (ident.type || ident.identifierType || '').trim().toLowerCase(),
      )
      .filter(Boolean),
  );
  for (const d of idDefs) {
    if (d.val && !existingTypes.has(d.type)) {
      existingIdents.push({
        type: d.type,
        value: d.val,
        canonicalUri: d.uri(d.val),
      });
      existingTypes.add(d.type);
    }
  }
  it.identifiers = existingIdents;
}

export function mapFlattenedStateHelper<T extends Record<string, unknown>>(
  item: T | null | undefined,
  toDomainFn: <U>(it: U) => U,
  userId?: string,
): (T & { readStatus: string; rating: number; lastReadAt: string | null }) | null {
  if (!item) return null;
  interface StateRecordLike {
    userId?: string;
    readStatus?: string;
    rating?: number;
    lastReadAt?: Date | string | null;
    [key: string]: unknown;
  }
  const normalized = toDomainFn(item) as Record<string, unknown>;
  const statesArr =
    Array.isArray(normalized.states) && normalized.states.length > 0
      ? (normalized.states as StateRecordLike[])
      : null;
  const userState = statesArr && userId
    ? statesArr.find((s) => s.userId === userId)
    : undefined;
  const { states: _states, ...rest } = normalized;
  return {
    ...rest,
    isStarred:
      userState?.isStarred !== undefined
        ? Boolean(userState.isStarred)
        : Boolean(normalized.isStarred),
    readStatus: userState?.readStatus ?? 'unread',
    rating: userState?.rating ?? 0,
    currentPage: (userState?.currentPage as number | null | undefined) ?? null,
    lastReadPage: (userState?.currentPage as number | null | undefined) ?? null,
    scrollPosition: (userState?.scrollPosition as Record<string, unknown> | number | null | undefined) ?? null,
    lastOpenedAt: userState?.lastOpenedAt
      ? userState.lastOpenedAt instanceof Date
        ? userState.lastOpenedAt.toISOString()
        : String(userState.lastOpenedAt)
      : null,
    lastReadAt: userState?.lastReadAt
      ? userState.lastReadAt instanceof Date
        ? userState.lastReadAt.toISOString()
        : String(userState.lastReadAt)
      : null,
  } as unknown as T & { readStatus: string; rating: number; lastReadAt: string | null };
}
