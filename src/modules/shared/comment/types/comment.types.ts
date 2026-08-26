/**
 * Author details stored with comment replies
 */
export interface CommentAuthor {
  id: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
}

/**
 * Nested reply in page/task comments
 */
export interface CommentReply {
  id: string;
  content: string;
  author: CommentAuthor | null;
  createdAt: string;
}

/**
 * Reaction item in task comments
 */
export interface CommentReaction {
  id: string;
  emoji: string;
  users: string[];
}

/**
 * Safe parser for Comment replies JSON field
 */
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

/**
 * Safe parser for Comment reactions JSON field
 */
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
