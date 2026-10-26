import {
  CreatorCreditInput,
} from '@/modules/library/core/types/bibliographic.types';
import { resolveCanonicalCreatorRole } from './zotero-field-harmonizer.domain';
import {
  isNoiseAuthorName,
  splitAuthorString,
  parseCreatorString,
} from './author.domain';

export function extractCreatorString(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const obj = input as {
      fullName?: unknown;
      name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    };
    if (typeof obj.fullName === 'string' && obj.fullName.trim()) {
      return obj.fullName.trim();
    }
    if (typeof obj.name === 'string' && obj.name.trim()) {
      return obj.name.trim();
    }
    const parts = [obj.firstName, obj.lastName].filter(
      (p): p is string => typeof p === 'string' && Boolean(p.trim()),
    );
    return parts.join(' ');
  }
  return typeof input === 'number' || typeof input === 'boolean'
    ? String(input)
    : '';
}

/**
 * Canonical creator merging and normalization across all library entry points.
 * Preserves explicit `creatorType` via `resolveCanonicalCreatorRole`, splits full names
 * when `firstName` or `lastName` is missing (`fieldMode = 0` vs `1`), and deduplicates
 * creators by `${creatorType}:${lastName}:${firstName}`.
 */
export function mergeCanonicalCreators(
  input: {
    creators?: unknown[];
    contributors?: unknown[];
    authors?: unknown[];
    editors?: unknown[];
    itemType?: string;
  },
  primaryRole: string = 'author',
): CreatorCreditInput[] | undefined {
  const initialCreators = (
    Array.isArray(input.contributors) && input.contributors.length > 0
      ? input.contributors
      : Array.isArray(input.creators)
        ? input.creators
        : []
  ) as CreatorCreditInput[];

  const creators: CreatorCreditInput[] = [];
  const knownCreators = new Set<string>();

  const append = (
    name: string,
    creatorType: string = primaryRole,
    firstName?: string,
    lastName?: string,
    fieldMode?: number,
    shortName?: string,
    orderIndex?: number,
  ) => {
    const cleanName = (name || '').trim();
    let finalFirst = firstName?.trim() || '';
    let finalLast = lastName?.trim() || '';
    let finalFull = cleanName;
    let finalFieldMode = fieldMode;

    if (finalFieldMode === 1) {
      const single = finalLast || finalFull || finalFirst;
      if (!single || isNoiseAuthorName(single)) return;
      finalFirst = '';
      finalLast = single;
      finalFull = single;
    } else if (cleanName.includes(',') || !finalFirst || !finalLast) {
      const rawToParse = cleanName || `${finalFirst} ${finalLast}`.trim();
      if (!rawToParse || isNoiseAuthorName(rawToParse)) return;
      const parsed = parseCreatorString(
        rawToParse,
        orderIndex ?? creators.length,
        creatorType,
      );
      if (parsed.fieldMode === 1) {
        finalFieldMode = 1;
        finalFirst = '';
        finalLast = parsed.lastName || parsed.fullName;
        finalFull = parsed.fullName;
      } else {
        if (!finalFirst || !finalLast) {
          finalFirst = finalFirst || parsed.firstName;
          finalLast = finalLast || parsed.lastName;
        }
        finalFull =
          parsed.fullName || `${finalFirst} ${finalLast}`.trim();
      }
    } else if (!finalFull) {
      finalFull = `${finalFirst} ${finalLast}`.trim();
    }

    if (!finalFull && !finalFirst && !finalLast) return;
    if (isNoiseAuthorName(finalFull || `${finalFirst} ${finalLast}`.trim())) {
      return;
    }

    const dedupKey =
      finalLast || finalFirst
        ? `${creatorType}:${finalLast.toLowerCase()}:${finalFirst.toLowerCase()}`
        : `${creatorType}:${finalFull.toLowerCase()}`;
    if (knownCreators.has(dedupKey)) return;
    knownCreators.add(dedupKey);

    const displayFull = finalFull || `${finalFirst} ${finalLast}`.trim();
    creators.push({
      name: displayFull,
      fullName: displayFull,
      creatorType,
      firstName: finalFieldMode === 1 ? '' : finalFirst || '',
      lastName: finalLast || '',
      ...(finalFieldMode !== undefined ? { fieldMode: finalFieldMode } : {}),
      ...(shortName ? { shortName } : {}),
      orderIndex: orderIndex !== undefined ? orderIndex : creators.length,
    });
  };

  for (const rawC of initialCreators) {
    if (!rawC) continue;
    if (typeof rawC === 'string') {
      const role = resolveCanonicalCreatorRole(primaryRole, {
        itemType: input.itemType,
      });
      for (const splitPart of splitAuthorString(rawC)) {
        append(splitPart, role);
      }
      continue;
    }
    const c = rawC as CreatorCreditInput & Record<string, unknown>;
    const creatorType = resolveCanonicalCreatorRole(
      c.creatorType || primaryRole,
      { itemType: input.itemType },
    );
    const cFieldMode =
      typeof c.fieldMode === 'number' ? c.fieldMode : undefined;
    const cShortName =
      typeof c.shortName === 'string' && c.shortName.trim()
        ? c.shortName.trim()
        : undefined;
    const cOrderIndex =
      typeof c.orderIndex === 'number' ? c.orderIndex : undefined;

    if (cFieldMode === 1) {
      const singleName =
        c.lastName || c.fullName || c.name || c.firstName || '';
      append(singleName, creatorType, '', singleName, 1, cShortName, cOrderIndex);
      continue;
    }

    const rawName = extractCreatorString(c);
    if (rawName) {
      const parts =
        c.firstName || c.lastName ? [rawName] : splitAuthorString(rawName);
      for (const p of parts) {
        append(
          p,
          creatorType,
          c.firstName || undefined,
          c.lastName || undefined,
          cFieldMode,
          cShortName,
          cOrderIndex,
        );
      }
    } else if (c.firstName || c.lastName) {
      append(
        '',
        creatorType,
        c.firstName || undefined,
        c.lastName || undefined,
        cFieldMode,
        cShortName,
        cOrderIndex,
      );
    }
  }

  const appendStringRoleList = (
    list: unknown[] | undefined,
    role: string,
    checkAnyInitialRole: boolean,
  ) => {
    const resolvedRole = resolveCanonicalCreatorRole(role, {
      itemType: input.itemType,
    });
    for (const rawEntry of list || []) {
      const rawStr = extractCreatorString(rawEntry).trim();
      if (!rawStr) continue;
      const lowerStr = rawStr.toLowerCase();
      if (
        checkAnyInitialRole &&
        initialCreators.some(
          (ic) => extractCreatorString(ic).trim().toLowerCase() === lowerStr,
        )
      ) {
        continue;
      }
      if (
        knownCreators.has(`${resolvedRole}:${lowerStr}:`) ||
        knownCreators.has(`${resolvedRole}:${lowerStr}`)
      ) {
        continue;
      }
      for (const splitPart of splitAuthorString(rawStr)) {
        append(splitPart, resolvedRole);
      }
    }
  };

  appendStringRoleList(input.authors, primaryRole, true);
  appendStringRoleList(input.editors, 'editor', false);

  return creators.length > 0 ? creators : undefined;
}
