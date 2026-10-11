/**
 * notifications/core/domain/review-bundle.ts
 *
 * Pure domain rules for Overleaf-style review notification bundling:
 * unread review notifications are grouped per project inside a time window
 * and collapsed into a digest when the window elapses or on explicit flush.
 */

import { NotificationEntity } from '../entities/notification.entity';

export const REVIEW_NOTIFICATION_TYPES = new Set([
  'mention',
  'comment_reply',
  'thread_resolved',
  'review_request',
]);

export type BundledEventType = 'mention' | 'comment' | 'reply' | 'suggestion';

export interface ReviewBundlingSettings {
  enabled: boolean;
  windowMinutes: number;
}

export const DEFAULT_BUNDLING_SETTINGS: ReviewBundlingSettings = {
  enabled: true,
  windowMinutes: 10,
};

export function normalizeSettings(raw: any): ReviewBundlingSettings {
  const minutes = Number(raw?.windowMinutes);
  return {
    enabled:
      typeof raw?.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_BUNDLING_SETTINGS.enabled,
    windowMinutes:
      Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440
        ? Math.round(minutes)
        : DEFAULT_BUNDLING_SETTINGS.windowMinutes,
  };
}

export interface BundledItem {
  id: string;
  type: BundledEventType;
  authorId: string;
  authorName: string;
  pageId: string;
  projectId?: string;
  targetId?: string;
  contentSnippet: string;
  line?: number;
  timestamp: string;
}

export interface PendingBundle {
  bundle: {
    recipientId: string;
    projectId?: string;
    items: BundledItem[];
    createdAt: string;
    flushAt: string;
  };
  itemCount: number;
  remainingSeconds: number;
}

export interface ReviewDigest {
  id: string;
  recipientId: string;
  projectId?: string;
  summary: string;
  itemCount: number;
  mentionCount: number;
  commentCount: number;
  replyCount: number;
  suggestionCount: number;
  authorSummaries: Array<{
    authorId: string;
    authorName: string;
    mentionCount: number;
    commentCount: number;
    replyCount: number;
    suggestionCount: number;
  }>;
  items: BundledItem[];
  createdAt: string;
  windowMinutes: number;
}

export function toBundledType(n: NotificationEntity): BundledEventType {
  const hinted = n.messageOpts?.eventType;
  if (
    typeof hinted === 'string' &&
    ['mention', 'comment', 'reply', 'suggestion'].includes(hinted)
  ) {
    return hinted as BundledEventType;
  }
  switch (n.type) {
    case 'mention':
      return 'mention';
    case 'comment_reply':
      return 'reply';
    case 'review_request':
      return 'suggestion';
    default:
      return 'comment';
  }
}

export function toBundledItem(n: NotificationEntity): BundledItem {
  const o = n.messageOpts || {};
  const optStr = (key: string): string | undefined =>
    typeof o[key] === 'string' ? (o[key] as string) : undefined;

  return {
    id: n.id,
    type: toBundledType(n),
    authorId: n.actorId || optStr('actorId') || 'unknown',
    authorName:
      optStr('actorName') ||
      optStr('authorName') ||
      optStr('userName') ||
      'Collaborator',
    pageId: n.docId || optStr('docId') || '',
    projectId: n.projectId || undefined,
    targetId:
      optStr('threadId') ||
      optStr('changeId') ||
      optStr('commentId') ||
      undefined,
    contentSnippet: String(
      o.snippet ?? o.content ?? o.message ?? '',
    ).slice(0, 280),
    line: typeof o.line === 'number' ? o.line : undefined,
    timestamp: n.createdAt.toISOString(),
  };
}

export function isReviewNotification(n: NotificationEntity): boolean {
  return REVIEW_NOTIFICATION_TYPES.has(n.type) && !n.isRead;
}

/** Groups unread review notifications by project into pending bundles. */
export function buildPendingBundles(
  recipientId: string,
  notifications: NotificationEntity[],
  settings: ReviewBundlingSettings,
  now: Date = new Date(),
): PendingBundle[] {
  const windowMs = settings.windowMinutes * 60_000;
  const groups = new Map<string, NotificationEntity[]>();
  for (const n of notifications.filter(isReviewNotification)) {
    const key = n.projectId || '';
    const list = groups.get(key) || [];
    list.push(n);
    groups.set(key, list);
  }
  const bundles: PendingBundle[] = [];
  for (const [projectId, list] of groups) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const createdAt = list[0].createdAt;
    const flushAt = new Date(createdAt.getTime() + windowMs);
    bundles.push({
      bundle: {
        recipientId,
        projectId: projectId || undefined,
        items: list.map(toBundledItem),
        createdAt: createdAt.toISOString(),
        flushAt: flushAt.toISOString(),
      },
      itemCount: list.length,
      remainingSeconds: Math.max(
        0,
        Math.ceil((flushAt.getTime() - now.getTime()) / 1000),
      ),
    });
  }
  return bundles.sort((a, b) => a.remainingSeconds - b.remainingSeconds);
}

export function buildDigest(
  recipientId: string,
  items: BundledItem[],
  windowMinutes: number,
  projectId?: string,
  now: Date = new Date(),
): ReviewDigest {
  const counts = { mention: 0, comment: 0, reply: 0, suggestion: 0 };
  const authors = new Map<string, ReviewDigest['authorSummaries'][number]>();
  for (const it of items) {
    counts[it.type]++;
    const a = authors.get(it.authorId) || {
      authorId: it.authorId,
      authorName: it.authorName,
      mentionCount: 0,
      commentCount: 0,
      replyCount: 0,
      suggestionCount: 0,
    };
    a[`${it.type}Count` as 'mentionCount']++;
    authors.set(it.authorId, a);
  }
  const parts: string[] = [];
  if (counts.mention) parts.push(`${counts.mention} mention${counts.mention > 1 ? 's' : ''}`);
  if (counts.comment) parts.push(`${counts.comment} comment${counts.comment > 1 ? 's' : ''}`);
  if (counts.reply) parts.push(`${counts.reply} repl${counts.reply > 1 ? 'ies' : 'y'}`);
  if (counts.suggestion) parts.push(`${counts.suggestion} suggestion${counts.suggestion > 1 ? 's' : ''}`);
  return {
    id: `digest-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    recipientId,
    projectId,
    summary: parts.length
      ? `${parts.join(', ')} from ${authors.size} collaborator${authors.size > 1 ? 's' : ''}`
      : 'No new review activity',
    itemCount: items.length,
    mentionCount: counts.mention,
    commentCount: counts.comment,
    replyCount: counts.reply,
    suggestionCount: counts.suggestion,
    authorSummaries: [...authors.values()],
    items,
    createdAt: now.toISOString(),
    windowMinutes,
  };
}
