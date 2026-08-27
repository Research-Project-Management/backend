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

export interface CommentReaction {
  id: string;
  emoji: string;
  users: string[];
}

export function parseCommentReplies(raw: unknown): CommentReply[] {
  if (!raw || !Array.isArray(raw)) return [];
  const list: unknown[] = raw;
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

export function parseCommentReactions(raw: unknown): CommentReaction[] {
  if (!raw || !Array.isArray(raw)) return [];
  const list: unknown[] = raw;
  return list.filter(
    (item: unknown): item is CommentReaction =>
      typeof item === 'object' &&
      item !== null &&
      'emoji' in item &&
      typeof (item as Record<string, unknown>).emoji === 'string' &&
      'users' in item &&
      Array.isArray((item as Record<string, unknown>).users),
  );
}
