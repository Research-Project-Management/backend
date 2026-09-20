export interface CommentAuthor {
  id: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
}

export interface CommentReply {
  id: string;
  content: string;
  author: CommentAuthor | null;
  createdAt: string;
}

export function parseCommentReplies(raw: unknown): CommentReply[] {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsed || !Array.isArray(parsed)) return [];
  const list: unknown[] = parsed;
  return list.filter(
    (item: unknown): item is CommentReply =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      'content' in item &&
      typeof (item as Record<string, unknown>).content === 'string',
  );
}
