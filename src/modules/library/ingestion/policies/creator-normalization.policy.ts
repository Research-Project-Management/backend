import { CreatorInput } from '@/modules/library/ingestion/types/metadata.types';
import {
  isInstitutionName,
  splitAuthorString,
  parseCreatorString,
  cleanBibliographicText,
} from '@/modules/library/core';
import {
  resolveCanonicalCreatorRole,
  getPrimaryCreatorRoleForType,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';

function cleanCreatorString(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') {
    return cleanBibliographicText(val);
  }
  if (
    typeof val === 'number' ||
    typeof val === 'boolean' ||
    typeof val === 'bigint'
  ) {
    return String(val).trim();
  }
  return undefined;
}

/**
 * Normalizes creators, authors, and editors into canonical CreatorInput array.
 */
export function normalizeCreators(
  creatorsInput?: CreatorInput[],
  authorsInput?: string[],
  editorsInput?: string[],
  itemType?: string,
): CreatorInput[] {
  const list: CreatorInput[] = [];

  const append = (creator: CreatorInput) => {
    const creatorType = resolveCanonicalCreatorRole(creator.creatorType, {
      itemType,
    });
    let firstName = (creator.firstName || '').trim();
    let lastName = (creator.lastName || '').trim();
    let fullName = (creator.fullName || creator.name || '').trim();
    let fieldMode: number | undefined = creator.fieldMode;
    const shortName = cleanCreatorString(creator.shortName);

    if (fieldMode === 1) {
      const single = cleanCreatorString(lastName || fullName || firstName);
      if (!single) return;
      list.push({
        creatorType,
        name: single,
        fullName: single,
        lastName: single,
        fieldMode: 1,
        ...(shortName ? { shortName } : {}),
      });
      return;
    }

    const looksLikeOrg =
      !firstName && !!fullName && isInstitutionName(fullName);

    if (
      fullName &&
      !looksLikeOrg &&
      !firstName &&
      !lastName &&
      (fullName.includes(';') || /\s+(?:and|&)\s+/i.test(fullName))
    ) {
      const parts = splitAuthorString(fullName);
      if (parts.length > 1) {
        for (const part of parts) {
          append({ creatorType, fullName: part });
        }
        return;
      }
    }

    if (fullName && (fullName.includes(',') || (!firstName && !lastName))) {
      const parsed = parseCreatorString(fullName, 0, creatorType);
      if (parsed.fieldMode === 1) {
        fieldMode = 1;
        firstName = '';
        lastName = parsed.lastName || fullName;
        fullName = parsed.fullName || fullName;
      } else {
        firstName = parsed.firstName || firstName;
        lastName = parsed.lastName || lastName;
        fullName = parsed.fullName || fullName;
      }
    } else if (!fullName && (firstName || lastName)) {
      fullName = `${firstName} ${lastName}`.trim();
    }

    const cleanFirst = cleanCreatorString(firstName) || '';
    const cleanLast = cleanCreatorString(lastName) || '';
    const cleanFull = cleanCreatorString(fullName) || '';

    if (!cleanFull && !cleanFirst && !cleanLast) return;

    const effectiveName = cleanFull || `${cleanFirst} ${cleanLast}`.trim();

    list.push({
      creatorType,
      name: effectiveName,
      fullName: effectiveName,
      firstName: fieldMode === 1 ? undefined : cleanFirst || undefined,
      lastName: cleanLast || (fieldMode === 1 ? effectiveName : undefined),
      fieldMode: fieldMode === 1 ? 1 : 0,
      ...(shortName ? { shortName } : {}),
    });
  };

  const hasStructuredCreators =
    Array.isArray(creatorsInput) && creatorsInput.length > 0;
  const primaryRole = getPrimaryCreatorRoleForType(itemType);

  if (hasStructuredCreators) {
    for (const c of creatorsInput) {
      if (!c || typeof c !== 'object') continue;
      append(c);
    }
  }

  if (Array.isArray(authorsInput) && authorsInput.length > 0) {
    const existingList = [...list];
    list.length = 0;
    for (const a of authorsInput as unknown[]) {
      if (a && typeof a === 'object') {
        const obj = a as CreatorInput;
        append({ ...obj, creatorType: obj.creatorType || primaryRole });
        continue;
      }
      if (typeof a !== 'string') continue;
      for (const author of splitAuthorString(a)) {
        const cleanA = cleanCreatorString(author);
        if (!cleanA) continue;
        const parsed = parseCreatorString(cleanA, 0, primaryRole);
        append({
          creatorType: primaryRole,
          name: parsed.fullName,
          fullName: parsed.fullName,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fieldMode: parsed.fieldMode,
        });
      }
    }
    const parsedAuthors = [...list];
    list.length = 0;

    if (!hasStructuredCreators) {
      list.push(...parsedAuthors);
    } else if (parsedAuthors.length > 0) {
      const isPrimaryRole = (role?: string) => {
        const r = (role || 'author').toLowerCase();
        return r === 'author' || r === primaryRole.toLowerCase();
      };
      const existingPrimary = existingList.filter((c) =>
        isPrimaryRole(c.creatorType),
      );
      const existingNonPrimary = existingList.filter(
        (c) => !isPrimaryRole(c.creatorType),
      );
      const existingPrimaryNames = new Set(
        existingPrimary.map((c) => (c.fullName || c.name || '').toLowerCase()),
      );
      const parsedAuthorNames = new Set(
        parsedAuthors.map((c) => (c.fullName || c.name || '').toLowerCase()),
      );
      const allExistingInParsed =
        existingPrimary.length > 0 &&
        existingPrimary.every((c) =>
          parsedAuthorNames.has((c.fullName || c.name || '').toLowerCase()),
        );
      if (existingPrimary.length === 0) {
        list.push(...parsedAuthors, ...existingNonPrimary);
      } else if (allExistingInParsed) {
        list.push(...existingPrimary);
        for (const pa of parsedAuthors) {
          if (
            !existingPrimaryNames.has(
              (pa.fullName || pa.name || '').toLowerCase(),
            )
          ) {
            list.push(pa);
          }
        }
        list.push(...existingNonPrimary);
      } else {
        // `authors` was overridden with new primary authors: replace primary creators while keeping non-primary contributors
        list.push(...parsedAuthors, ...existingNonPrimary);
      }
    } else {
      list.push(...existingList);
    }
  }

  const hasStructuredEditors =
    hasStructuredCreators &&
    creatorsInput.some((c) => c && c.creatorType === 'editor');

  if (!hasStructuredEditors && Array.isArray(editorsInput)) {
    for (const editor of editorsInput as unknown[]) {
      if (editor && typeof editor === 'object') {
        const obj = editor as CreatorInput;
        append({ ...obj, creatorType: 'editor' });
        continue;
      }
      if (typeof editor !== 'string') continue;
      for (const singleEditor of splitAuthorString(editor)) {
        const cleanEditor = cleanCreatorString(singleEditor);
        if (!cleanEditor) continue;
        const parsed = parseCreatorString(cleanEditor, 0, 'editor');
        append({
          creatorType: 'editor',
          name: parsed.fullName,
          fullName: parsed.fullName,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fieldMode: parsed.fieldMode,
        });
      }
    }
  }

  const seen = new Set<string>();
  const deduped: CreatorInput[] = [];
  for (const c of list) {
    const key = `${(c.creatorType || 'author').toLowerCase()}::${(c.fullName || c.name || '').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }
  return deduped;
}
