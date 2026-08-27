import { LibraryNote } from '../types/notes.types';

export function parseItemNotes(
  itemId: string,
  rawNotes: unknown,
): LibraryNote[] {
  if (!Array.isArray(rawNotes)) return [];
  return rawNotes.map((n: any, idx: number) => ({
    id: n.id || `${itemId}-note-${idx}`,
    itemId,
    title: n.title || 'Untitled Note',
    content: n.content || '',
    tags: n.tags || [],
    version: n.version || 1,
    authorId: n.authorId,
    createdAt: n.createdAt || new Date().toISOString(),
    updatedAt: n.updatedAt || new Date().toISOString(),
  }));
}
