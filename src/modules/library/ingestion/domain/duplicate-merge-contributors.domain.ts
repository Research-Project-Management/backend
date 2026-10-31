import { Prisma } from '@prisma/client';
import { asMetaObject } from './duplicate-clustering.helper';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  parseCreatorString,
  ItemProvenancePolicy,
  countFullGivenNames,
  isBetterAuthorListCandidate,
} from '@/modules/library/core';

export interface ContributorShape {
  creatorType?: string;
  fieldMode?: number;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  shortName?: string | null;
  name?: string;
  orderIndex?: number;
}

export const IDENTIFIER_META_KEYS = [
  'arxivId',
  'pmid',
  'pmcid',
  'isbn',
  'issn',
] as const;

export async function syncMergedContributors(
  tx: Prisma.TransactionClient,
  primaryId: string,
  chosenContributors: ContributorShape[] | string[] | undefined,
  duplicates: Array<{ contributors?: unknown; metadata?: unknown }>,
  primary?: Record<string, unknown> & {
    contributors?: unknown;
    metadata?: unknown;
  },
  primaryMeta?: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const mapContributorInput = (c: ContributorShape | string, idx: number) => {
    const cObj = typeof c === 'object' && c !== null ? c : null;
    const creatorType = cObj?.creatorType || 'author';
    let firstName = (cObj?.firstName || '').trim();
    let lastName = (cObj?.lastName || '').trim();
    let fullName = (
      cObj?.fullName ||
      cObj?.name ||
      [firstName, lastName].filter(Boolean).join(' ') ||
      (typeof c === 'string' ? c : '')
    ).trim();
    if (!firstName && !lastName && fullName) {
      const parsed = parseCreatorString(fullName, idx, creatorType);
      firstName = parsed.firstName || '';
      lastName = parsed.lastName || '';
      fullName = parsed.fullName || fullName;
    }
    return {
      itemId: primaryId,
      creatorType,
      fieldMode: cObj?.fieldMode ?? 0,
      firstName,
      lastName,
      fullName,
      shortName: cObj?.shortName ?? '',
      orderIndex: cObj?.orderIndex ?? idx,
    };
  };

  const syncMeta = (mapped: Array<ReturnType<typeof mapContributorInput>>) => {
    if (!primaryMeta) return;
    primaryMeta.creators = mapped.map((c) => ({
      creatorType: c.creatorType,
      fieldMode: c.fieldMode,
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: c.fullName,
      name: c.fullName,
      orderIndex: c.orderIndex,
    }));
    primaryMeta.authors = mapped
      .filter((c) => !c.creatorType || c.creatorType === 'author')
      .map(
        (c) =>
          c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' '),
      )
      .filter(Boolean);
  };

  const getContribs = (item?: {
    contributors?: unknown;
    metadata?: unknown;
  }): Array<ContributorShape | string> => {
    if (!item) return [];
    if (Array.isArray(item.contributors) && item.contributors.length > 0) {
      return item.contributors as ContributorShape[];
    }
    const meta = asMetaObject(item.metadata);
    if (Array.isArray(meta.creators) && meta.creators.length > 0) {
      return meta.creators as ContributorShape[];
    }
    if (Array.isArray(meta.authors) && meta.authors.length > 0) {
      return meta.authors as Array<ContributorShape | string>;
    }
    return [];
  };

  if (Array.isArray(chosenContributors)) {
    await tx.contributor.deleteMany({ where: { itemId: primaryId } });
    if (chosenContributors.length === 0) {
      syncMeta([]);
      return [];
    }
    const data = chosenContributors.map(mapContributorInput);
    await tx.contributor.createMany({ data });
    syncMeta(data);
    return data;
  }

  const effectivePrimaryMeta = primaryMeta ?? asMetaObject(primary?.metadata);
  const isPrimaryCreatorsLocked = ItemProvenancePolicy.isFieldLocked(
    effectivePrimaryMeta,
    'creators',
    ['authors', 'contributors'],
  );

  if (!isPrimaryCreatorsLocked) {
    for (const dup of duplicates) {
      const dupMeta = asMetaObject(dup.metadata);
      const locked =
        ItemProvenancePolicy.inspectFieldUserLock(dupMeta, 'creators').locked ||
        ItemProvenancePolicy.inspectFieldUserLock(dupMeta, 'authors').locked;
      if (locked) {
        const dupContribs = getContribs(dup);
        if (dupContribs.length > 0) {
          await tx.contributor.deleteMany({ where: { itemId: primaryId } });
          const data = dupContribs.map(mapContributorInput);
          await tx.contributor.createMany({ data });
          syncMeta(data);
          if (primaryMeta) {
            const existingLocked = Array.isArray(primaryMeta.lockedFields)
              ? (primaryMeta.lockedFields as string[])
              : [];
            primaryMeta.lockedFields = Array.from(
              new Set([...existingLocked, 'creators', 'authors']),
            );
          }
          return data;
        }
      }
    }
  }

  const primaryContribCount =
    typeof tx.contributor?.count === 'function'
      ? await tx.contributor.count({ where: { itemId: primaryId } })
      : 0;
  const primaryContribs = getContribs(primary);

  const sortedDups = duplicates
    .map((dup) => {
      const list = getContribs(dup);
      return {
        list,
        auth: ItemProvenancePolicy.getFieldAuthority(
          dup,
          'creators',
          list.length > 0,
          ['authors', 'contributors'],
        ),
        fullGivenCount: countFullGivenNames(list),
      };
    })
    .filter((e) => e.list.length > 0)
    .sort(
      (a, b) =>
        b.auth - a.auth ||
        b.fullGivenCount - a.fullGivenCount ||
        b.list.length - a.list.length,
    );

  if (sortedDups.length === 0) return [];
  const bestDonor = sortedDups[0];

  if (primaryContribCount === 0 && primaryContribs.length === 0) {
    const data = bestDonor.list.map(mapContributorInput);
    await tx.contributor.createMany({ data });
    syncMeta(data);
    return data;
  }

  if (!isPrimaryCreatorsLocked && primaryContribs.length > 0) {
    const primaryAuth = ItemProvenancePolicy.getFieldAuthority(
      primary ?? effectivePrimaryMeta,
      'creators',
      true,
      ['authors', 'contributors'],
    );
    const shouldUpgrade = isBetterAuthorListCandidate(
      bestDonor.auth,
      bestDonor.list.length,
      bestDonor.fullGivenCount,
      primaryAuth,
      primaryContribs.length,
      countFullGivenNames(primaryContribs),
    );
    if (shouldUpgrade) {
      await tx.contributor.deleteMany({ where: { itemId: primaryId } });
      const data = bestDonor.list.map(mapContributorInput);
      await tx.contributor.createMany({ data });
      syncMeta(data);
      return data;
    }
  }

  return [];
}

export async function syncMergedIdentifiersInTx(params: {
  tx: Prisma.TransactionClient;
  primaryId: string;
  uniqueDupIds: string[];
  primaryMeta: Record<string, unknown>;
  topLevelData: Record<string, unknown>;
  primaryDoi?: string | null;
  explicitlyClearedFields?: ReadonlySet<string>;
}): Promise<void> {
  const {
    tx,
    primaryId,
    uniqueDupIds,
    primaryMeta,
    topLevelData,
    primaryDoi,
    explicitlyClearedFields,
  } = params;
  const identTx = tx as unknown as {
    itemIdentifier?: {
      findMany?: (args: { where: { itemId: { in: string[] } } }) => Promise<
        Array<{
          itemId: string;
          type: string;
          value: string;
          canonicalUri?: string | null;
        }>
      >;
      upsert?: (args: {
        where: { itemId_type: { itemId: string; type: string } };
        update: { value: string; canonicalUri: string };
        create: {
          itemId: string;
          type: string;
          value: string;
          canonicalUri: string;
        };
      }) => Promise<unknown>;
      deleteMany?: (args: {
        where: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  };

  const canonicalIdType = (t: string) => {
    const norm = t.trim().toLowerCase();
    return norm === 'arxivid' || norm === 'archiveid' ? 'arxiv' : norm;
  };

  const clearedCanonicalTypes = new Set<string>();
  if (explicitlyClearedFields) {
    for (const f of explicitlyClearedFields) {
      const cType = canonicalIdType(f);
      if (['doi', 'arxiv', 'pmid', 'pmcid', 'isbn', 'issn'].includes(cType)) {
        clearedCanonicalTypes.add(cType);
      }
    }
  }
  if (topLevelData.doi === null) {
    clearedCanonicalTypes.add('doi');
  }
  if (clearedCanonicalTypes.has('doi')) {
    topLevelData.doi = null;
    delete primaryMeta.doi;
    delete primaryMeta.DOI;
  }
  for (const key of IDENTIFIER_META_KEYS) {
    const cType = key === 'arxivId' ? 'arxiv' : key;
    if (clearedCanonicalTypes.has(cType)) {
      delete primaryMeta[key];
      for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(key)) {
        delete primaryMeta[alias];
      }
    }
  }

  if (!identTx.itemIdentifier) return;

  const existingIdRecords = identTx.itemIdentifier.findMany
    ? await identTx.itemIdentifier.findMany({
        where: { itemId: { in: [primaryId, ...uniqueDupIds] } },
      })
    : [];

  const desiredByType = new Map<
    string,
    { type: string; value: string; canonicalUri: string }
  >();
  for (const rec of existingIdRecords) {
    if (rec.itemId === primaryId && rec.type && rec.value) {
      const cType = canonicalIdType(rec.type);
      if (!clearedCanonicalTypes.has(cType)) {
        desiredByType.set(cType, {
          type: cType,
          value: rec.value,
          canonicalUri: rec.canonicalUri || rec.value,
        });
      }
    }
  }
  for (const rec of existingIdRecords) {
    if (rec.itemId !== primaryId && rec.type && rec.value) {
      const cType = canonicalIdType(rec.type);
      if (!clearedCanonicalTypes.has(cType) && !desiredByType.has(cType)) {
        desiredByType.set(cType, {
          type: cType,
          value: rec.value,
          canonicalUri: rec.canonicalUri || rec.value,
        });
      }
    }
  }

  if (!clearedCanonicalTypes.has('doi')) {
    const effectiveDoiRaw = topLevelData.doi ?? primaryMeta.doi ?? primaryDoi;
    if (typeof effectiveDoiRaw === 'string' && effectiveDoiRaw.trim()) {
      const cleanDoi = normalizeDoi(effectiveDoiRaw) || effectiveDoiRaw.trim();
      desiredByType.set('doi', {
        type: 'doi',
        value: cleanDoi,
        canonicalUri: `https://doi.org/${cleanDoi}`,
      });
    } else {
      const discoveredDoi = desiredByType.get('doi')?.value;
      if (discoveredDoi && discoveredDoi.trim()) {
        const cleanDoi = normalizeDoi(discoveredDoi) || discoveredDoi.trim();
        topLevelData.doi = cleanDoi;
        primaryMeta.doi = cleanDoi;
        desiredByType.set('doi', {
          type: 'doi',
          value: cleanDoi,
          canonicalUri: `https://doi.org/${cleanDoi}`,
        });
      }
    }
  }

  const idNormMap = {
    arxivId: {
      norm: normalizeArxivId,
      uri: (v: string) => `https://arxiv.org/abs/${v}`,
    },
    pmid: {
      norm: normalizePmid,
      uri: (v: string) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
    },
    pmcid: {
      norm: normalizePmcid,
      uri: (v: string) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${v}/`,
    },
    isbn: { norm: normalizeIsbn, uri: (v: string) => `urn:isbn:${v}` },
    issn: { norm: normalizeIssn, uri: (v: string) => `urn:issn:${v}` },
  } as const;

  for (const key of IDENTIFIER_META_KEYS) {
    const canonicalType = key === 'arxivId' ? 'arxiv' : key;
    if (clearedCanonicalTypes.has(canonicalType)) {
      desiredByType.delete(canonicalType);
      delete primaryMeta[key];
      continue;
    }
    const rawVal = primaryMeta[key];
    if (typeof rawVal === 'string' && rawVal.trim()) {
      const cleanVal = idNormMap[key].norm(rawVal) || rawVal.trim();
      desiredByType.set(canonicalType, {
        type: canonicalType,
        value: cleanVal,
        canonicalUri: idNormMap[key].uri(cleanVal),
      });
    } else {
      const discovered = desiredByType.get(canonicalType)?.value;
      if (discovered && discovered.trim()) {
        const cleanVal = idNormMap[key].norm(discovered) || discovered.trim();
        primaryMeta[key] = cleanVal;
        desiredByType.set(canonicalType, {
          type: canonicalType,
          value: cleanVal,
          canonicalUri: idNormMap[key].uri(cleanVal),
        });
      }
    }
  }

  if (identTx.itemIdentifier.deleteMany && uniqueDupIds.length > 0) {
    await identTx.itemIdentifier.deleteMany({
      where: { itemId: { in: uniqueDupIds } },
    });
  }
  if (identTx.itemIdentifier.deleteMany && clearedCanonicalTypes.size > 0) {
    await identTx.itemIdentifier.deleteMany({
      where: {
        itemId: primaryId,
        type: { in: Array.from(clearedCanonicalTypes) },
      },
    });
  }

  if (identTx.itemIdentifier.upsert) {
    await Promise.all(
      Array.from(desiredByType.values(), (idObj) =>
        identTx.itemIdentifier!.upsert!({
          where: { itemId_type: { itemId: primaryId, type: idObj.type } },
          update: { value: idObj.value, canonicalUri: idObj.canonicalUri },
          create: { itemId: primaryId, ...idObj },
        }),
      ),
    );
  }
}
