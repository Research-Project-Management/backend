import { ExportItemRecord } from '@/modules/library/citation/repositories/exports.repository';
import { CslJsonMapper } from './csl-json.mapper';

/**
 * Extracts merged citation keys (from DuplicateService.mergeDuplicates) and
 * BetterBibTeX tex.ids / Citation Key aliases from item metadata.
 */
export function extractItemCitationAliases(it: ExportItemRecord): string[] {
  const aliases = new Set<string>();
  const metaObj =
    it.metadata &&
    typeof it.metadata === 'object' &&
    !Array.isArray(it.metadata)
      ? (itemMetaAsRecord(it.metadata))
      : {};

  const addKey = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) {
      for (const token of val.split(/[,;\s]+/)) {
        const trimmed = token.trim();
        if (trimmed) aliases.add(trimmed);
      }
    }
  };

  if (Array.isArray(metaObj.mergedCitationKeys)) {
    for (const k of metaObj.mergedCitationKeys) addKey(k);
  }
  addKey(metaObj.citationKey);
  addKey(metaObj['citation-key']);
  addKey(metaObj['tex.ids']);

  if (
    metaObj.extra &&
    typeof metaObj.extra === 'object' &&
    !Array.isArray(metaObj.extra)
  ) {
    const extraObj = metaObj.extra as Record<string, unknown>;
    if (Array.isArray(extraObj.mergedCitationKeys)) {
      for (const k of extraObj.mergedCitationKeys) addKey(k);
    }
    addKey(extraObj['tex.ids']);
    addKey(extraObj['citation-key']);
    addKey(extraObj['citationKey']);
    addKey(extraObj['bibtex']);
  }

  const csl = CslJsonMapper.toCsl(it);
  if (typeof csl['citation-key'] === 'string') {
    addKey(csl['citation-key']);
  }

  const rawExtraStr =
    typeof metaObj.extra === 'string'
      ? metaObj.extra
      : typeof (it as Record<string, unknown>).extra === 'string'
        ? ((it as Record<string, unknown>).extra as string)
        : '';
  if (rawExtraStr) {
    const match = rawExtraStr.match(
      /(?:^|\r?\n)\s*(?:citation[-_\s]?key|cite[-_\s]?key|bibtex|tex\.ids)\s*:\s*([^\r\n]+)/i,
    );
    if (match?.[1]) {
      addKey(match[1]);
    }
  }

  return Array.from(aliases);
}

function itemMetaAsRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

export interface EmittedCitationEntry {
  item: ExportItemRecord;
  emitCiteKey: string;
}

export interface ResolvedCitationKeysResult {
  foundKeys: string[];
  missingKeys: string[];
  emittedEntries: EmittedCitationEntry[];
}

export function resolveEmittedCitationEntries(
  allCandidateItems: ExportItemRecord[],
  trimmedKeys: string[],
): ResolvedCitationKeysResult {
  const normalizedKeys = trimmedKeys.map((k) => k.toLowerCase());
  const keySet = new Set(normalizedKeys);
  const originalKeyByLower = new Map<string, string>();
  for (const rawKey of trimmedKeys) {
    const lower = rawKey.toLowerCase();
    if (!originalKeyByLower.has(lower)) {
      originalKeyByLower.set(lower, rawKey);
    }
  }

  const foundKeys: string[] = [];
  const emittedEntries: EmittedCitationEntry[] = [];
  const emittedCiteKeySet = new Set<string>();

  for (const it of allCandidateItems) {
    const primaryCiteKey = it.citationKey || '';
    const itemId = it.id || '';
    const aliases = extractItemCitationAliases(it);

    let itemMatchedPrimary = false;
    if (primaryCiteKey && keySet.has(primaryCiteKey.toLowerCase())) {
      foundKeys.push(primaryCiteKey);
      itemMatchedPrimary = true;
      const lowerPrimary = primaryCiteKey.toLowerCase();
      if (!emittedCiteKeySet.has(lowerPrimary)) {
        emittedCiteKeySet.add(lowerPrimary);
        emittedEntries.push({ item: it, emitCiteKey: primaryCiteKey });
      }
    } else if (itemId && keySet.has(itemId.toLowerCase())) {
      foundKeys.push(itemId);
      itemMatchedPrimary = true;
      const emitKey = primaryCiteKey || itemId;
      const lowerEmit = emitKey.toLowerCase();
      if (!emittedCiteKeySet.has(lowerEmit)) {
        emittedCiteKeySet.add(lowerEmit);
        emittedEntries.push({ item: it, emitCiteKey: emitKey });
      }
    }

    for (const alias of aliases) {
      const lowerAlias = alias.toLowerCase();
      if (
        keySet.has(lowerAlias) &&
        lowerAlias !== primaryCiteKey.toLowerCase() &&
        lowerAlias !== itemId.toLowerCase()
      ) {
        const requestedKey = originalKeyByLower.get(lowerAlias) || alias;
        foundKeys.push(requestedKey);
        if (!emittedCiteKeySet.has(lowerAlias)) {
          emittedCiteKeySet.add(lowerAlias);
          emittedEntries.push({ item: it, emitCiteKey: requestedKey });
        }
      } else if (
        !itemMatchedPrimary &&
        keySet.has(lowerAlias) &&
        !emittedCiteKeySet.has(lowerAlias)
      ) {
        const requestedKey = originalKeyByLower.get(lowerAlias) || alias;
        foundKeys.push(requestedKey);
        emittedCiteKeySet.add(lowerAlias);
        emittedEntries.push({ item: it, emitCiteKey: requestedKey });
      }
    }
  }

  const foundKeySet = new Set(foundKeys.map((k: string) => k.toLowerCase()));
  const missingKeys = trimmedKeys.filter(
    (k) => !foundKeySet.has(k.trim().toLowerCase()),
  );

  return {
    foundKeys,
    missingKeys,
    emittedEntries,
  };
}
