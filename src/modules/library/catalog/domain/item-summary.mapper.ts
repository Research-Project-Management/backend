import {
  cleanCommentText,
  convertAcademicHtmlToMarkdown,
} from '@/modules/library/core';
import {
  normalizeTags,
  cleanSingleTag,
} from '@/modules/library/core/domain/tag.domain';
import { MutableItemPayload, parseJsonObject } from './item-mapper.types';

/**
 * Projects tags, collections, notes, user states, and relations.
 */
export function mapTagsCollectionsNotesPartial(it: MutableItemPayload): void {
  // User States
  if (!it.userStates && Array.isArray(it.states)) {
    it.userStates = it.states;
  }
  if (Array.isArray(it.userStates) && it.userStates.length > 0) {
    const active = it.userStates[0];
    if (it.isStarred === undefined && active?.isStarred !== undefined) {
      it.isStarred = Boolean(active.isStarred);
    }
    if (
      it.readStatus === undefined &&
      typeof active?.readStatus === 'string' &&
      active.readStatus
    ) {
      it.readStatus = active.readStatus;
    }
    if (it.rating === undefined && typeof active?.rating === 'number') {
      it.rating = active.rating;
    }
    if (!it.lastReadAt) {
      const stateWithReadAt = it.userStates.find((u) => u?.lastReadAt);
      if (stateWithReadAt?.lastReadAt) {
        it.lastReadAt =
          stateWithReadAt.lastReadAt instanceof Date
            ? stateWithReadAt.lastReadAt.toISOString()
            : (stateWithReadAt.lastReadAt as string);
      }
    }
  }

  // Tags & Zotero Tags
  const buildZoteroTags = (
    items: unknown[],
    extractEntry: (entry: unknown) => { rawName: string; isAuto: boolean },
  ) => {
    const seen = new Set<string>();
    return items
      .map((entry) => {
        const { rawName, isAuto } = extractEntry(entry);
        const cleanedName = cleanSingleTag(rawName);
        if (!cleanedName) return null;
        const lower = cleanedName.toLowerCase();
        if (seen.has(lower)) return null;
        seen.add(lower);
        return { tag: cleanedName, type: isAuto ? 1 : 0 };
      })
      .filter((zt): zt is NonNullable<typeof zt> => Boolean(zt));
  };

  if (Array.isArray(it.itemTags)) {
    const itemTagArr = it.itemTags;
    if (itemTagArr.length > 0) {
      const rawTagNames = itemTagArr
        .map(
          (t) =>
            (t.tag as { name?: string } | undefined)?.name ||
            (t.name as string | undefined),
        )
        .filter(Boolean) as string[];
      const tagNames = normalizeTags(rawTagNames);
      it.tags = tagNames;
      it.keywords = tagNames;
      it.zoteroTags = buildZoteroTags(itemTagArr, (entry) => {
        const t = entry as Record<string, unknown>;
        const tagObj = t.tag as { name?: string; type?: unknown } | undefined;
        return {
          rawName: tagObj?.name || (t.name as string | undefined) || '',
          isAuto:
            t.type === 'automatic' ||
            t.type === 1 ||
            (!t.type && tagObj?.type === 'automatic'),
        };
      });
    } else if (Array.isArray(it.tags) && it.tags.length > 0) {
      const rawTags = it.tags;
      const tagNames = normalizeTags(rawTags as string[]);
      it.tags = tagNames;
      it.keywords = tagNames;
      it.zoteroTags = buildZoteroTags(rawTags, (t) => {
        const tObj =
          typeof t === 'object' && t !== null
            ? (t as Record<string, unknown>)
            : null;
        const rawName =
          typeof t === 'string'
            ? t
            : (tObj?.tag as string) || (tObj?.name as string) || '';
        const isAuto = tObj?.type === 1 || tObj?.type === 'automatic';
        return { rawName, isAuto };
      });
    } else {
      it.tags = [];
      it.keywords = [];
      it.zoteroTags = [];
    }
  } else {
    const metaObj = parseJsonObject(it.metadata) || {};
    const firstNonEmptyArray = (candidates: unknown[]): unknown[] => {
      for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) return c;
      }
      return [];
    };
    const rawTags = firstNonEmptyArray([
      it.tags,
      it.keywords,
      metaObj.tags,
      metaObj.keywords,
    ]);
    const tagNames = normalizeTags(rawTags as string[]);
    it.tags = tagNames;
    it.keywords = tagNames;
    it.zoteroTags = buildZoteroTags(rawTags, (t) => {
      const tObj =
        typeof t === 'object' && t !== null
          ? (t as Record<string, unknown>)
          : null;
      const rawName =
        typeof t === 'string'
          ? t
          : (tObj?.tag as string) || (tObj?.name as string) || '';
      const isAuto = tObj?.type === 1 || tObj?.type === 'automatic';
      return { rawName, isAuto };
    });
  }

  // Collections
  if (Array.isArray(it.collectionItems) && it.collectionItems.length > 0) {
    const colItems = it.collectionItems;
    const firstCol = colItems[0].collection as { id?: string } | undefined;
    it.collectionId =
      it.collectionId ||
      (colItems[0].collectionId as string | undefined) ||
      firstCol?.id ||
      null;
    it.collectionIds = colItems
      .map(
        (ci) =>
          (ci.collectionId as string | undefined) ||
          (ci.collection as { id?: string } | undefined)?.id,
      )
      .filter(Boolean) as string[];
    it.collections = colItems.map((ci) => ci.collection).filter(Boolean);
  } else {
    it.collectionId = it.collectionId || null;
    it.collectionIds = it.collectionIds || [];
    it.collections = it.collections || [];
  }

  // Notes
  const cleanNoteBody = convertAcademicHtmlToMarkdown;

  const normalizeNoteList = (list: Array<Record<string, unknown>>) => {
    const seen = new Set<string>();
    return list
      .map((n) => {
        const rawText = (n.contentMd || n.content || n.note || '') as string;
        const text = cleanNoteBody(rawText);
        if (!text) return null;
        const noteId =
          typeof n.id === 'string' && n.id.trim().length > 0
            ? n.id.trim()
            : null;
        const dedupeKey = noteId
          ? `id:${noteId}`
          : `text:${text.toLowerCase()}`;
        if (seen.has(dedupeKey)) return null;
        seen.add(dedupeKey);
        return {
          ...n,
          content: text,
          contentMd: text,
          note:
            typeof n.note === 'string' && n.note ? n.note : `<p>${text}</p>`,
          itemType: 'note',
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  };

  if (Array.isArray(it.notesList) && it.notesList.length > 0) {
    it.notes = normalizeNoteList(it.notesList);
  } else if (Array.isArray(it.notes) && it.notes.length > 0) {
    it.notes = normalizeNoteList(it.notes);
  } else if (it.extraFields && typeof it.extraFields.comment === 'string') {
    const commentVal = cleanCommentText(it.extraFields.comment);
    if (commentVal) {
      const formatted = commentVal.toLowerCase().startsWith('comment:')
        ? commentVal
        : `Comment: ${commentVal}`;
      it.notes = [
        {
          id: `comment-${it.id}`,
          content: formatted,
          contentMd: formatted,
          note: `<p>${formatted}</p>`,
          itemType: 'note',
          source: 'arXiv',
          createdAt: it.createdAt || new Date().toISOString(),
          updatedAt: it.updatedAt || new Date().toISOString(),
        },
      ];
    } else {
      it.notes = [];
    }
  } else {
    it.notes = [];
  }

  if (it.extraFields && 'comment' in it.extraFields) {
    delete it.extraFields.comment;
  }
}

/**
 * Projects user state (readStatus, rating, lastReadAt) to top level of domain item.
 */
export function mapFlattenedStateHelper<T extends Record<string, unknown>>(
  item: T | null | undefined,
  toDomainFn: <U>(it: U) => U,
  userId?: string,
):
  | (T & { readStatus: string; rating: number; lastReadAt: string | null })
  | null {
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
    Array.isArray(normalized.userStates) && normalized.userStates.length > 0
      ? (normalized.userStates as StateRecordLike[])
      : Array.isArray(normalized.states) && normalized.states.length > 0
        ? (normalized.states as StateRecordLike[])
        : null;

  const userState = statesArr
    ? (userId && statesArr.find((s) => s.userId === userId)) || statesArr[0]
    : undefined;

  const { userStates: _userStates, states: _states, ...rest } = normalized;
  return {
    ...rest,
    isStarred:
      userState?.isStarred !== undefined
        ? Boolean(userState.isStarred)
        : Boolean(normalized.isStarred),
    readStatus: userState?.readStatus ?? 'unread',
    rating: userState?.rating ?? 0,
    lastReadAt: userState?.lastReadAt
      ? userState.lastReadAt instanceof Date
        ? userState.lastReadAt.toISOString()
        : String(userState.lastReadAt)
      : null,
  } as unknown as T & {
    readStatus: string;
    rating: number;
    lastReadAt: string | null;
  };
}
