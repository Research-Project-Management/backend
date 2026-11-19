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

export function normalizeSettings(raw: unknown): ReviewBundlingSettings {
  const record =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const minutes = Number(record?.windowMinutes);
  return {
    enabled:
      typeof record?.enabled === 'boolean'
        ? record.enabled
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
  docId?: string | null;
  spaceId?: string | null;
  projectId?: string;
  targetId?: string;
  contentSnippet: string;
  line?: number;
  timestamp: string;
}

export interface PendingBundle {
  bundle: {
    scopeId?: string;
    recipientId: string;
    spaceId?: string | null;
    projectId?: string;
    pageId?: string | null;
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
  scopeId?: string;
  spaceId?: string | null;
  projectId?: string;
  pageId?: string | null;
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

function getOptString(n: NotificationEntity, key: string): string | undefined {
  const val = n.messageOpts?.[key];
  return typeof val === 'string' && val.trim().length > 0
    ? val.trim()
    : undefined;
}

export function getBundleScopeInfo(n: NotificationEntity): {
  scopeId: string;
  spaceId: string | null;
  projectId: string | undefined;
  explicitPageId: string | null;
} {
  const spaceId =
    n.spaceId ?? getOptString(n, 'spaceId') ?? n.projectId ?? null;
  const projectId =
    n.messageOpts?.isPersonalSpace === true
      ? undefined
      : (n.projectId ?? undefined);
  const explicitPageId = getOptString(n, 'pageId') ?? null;

  if (!spaceId && !projectId && !explicitPageId) {
    return {
      scopeId: '',
      spaceId: null,
      projectId: undefined,
      explicitPageId: null,
    };
  }

  const scopeId = explicitPageId
    ? `${spaceId || projectId || 'personal'}:${explicitPageId}`
    : spaceId || projectId || '';

  return {
    scopeId,
    spaceId,
    projectId: projectId || undefined,
    explicitPageId,
  };
}

export function toBundledItem(n: NotificationEntity): BundledItem {
  const o = n.messageOpts || {};
  const optStr = (key: string): string | undefined => getOptString(n, key);
  const { spaceId, projectId, explicitPageId } = getBundleScopeInfo(n);

  return {
    id: n.id,
    type: toBundledType(n),
    authorId: n.actorId || optStr('actorId') || 'unknown',
    authorName:
      optStr('actorName') ||
      optStr('authorName') ||
      optStr('userName') ||
      'Collaborator',
    pageId: explicitPageId || n.docId || optStr('docId') || '',
    docId: n.docId ?? optStr('docId') ?? null,
    spaceId,
    projectId,
    targetId:
      optStr('threadId') ||
      optStr('changeId') ||
      optStr('commentId') ||
      undefined,
    contentSnippet: String(o.snippet ?? o.content ?? o.message ?? '').slice(
      0,
      280,
    ),
    line: typeof o.line === 'number' ? o.line : undefined,
    timestamp: n.createdAt.toISOString(),
  };
}

export function isReviewNotification(n: NotificationEntity): boolean {
  return REVIEW_NOTIFICATION_TYPES.has(n.type) && !n.isRead;
}

/** Groups unread review notifications by space/page into pending bundles. */
export function buildPendingBundles(
  recipientId: string,
  notifications: NotificationEntity[],
  settings: ReviewBundlingSettings,
  now: Date = new Date(),
): PendingBundle[] {
  const windowMs = settings.windowMinutes * 60_000;
  const groups = new Map<
    string,
    {
      spaceId: string | null;
      projectId: string | undefined;
      pageId: string | null;
      items: NotificationEntity[];
    }
  >();

  for (const n of notifications.filter(isReviewNotification)) {
    const info = getBundleScopeInfo(n);
    const key = info.scopeId;
    const existing = groups.get(key) || {
      spaceId: info.spaceId,
      projectId: info.projectId,
      pageId: info.explicitPageId,
      items: [],
    };
    existing.items.push(n);
    groups.set(key, existing);
  }

  const bundles: PendingBundle[] = [];
  for (const [scopeId, group] of groups) {
    const list = group.items;
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const createdAt = list[0].createdAt;
    const flushAt = new Date(createdAt.getTime() + windowMs);
    bundles.push({
      bundle: {
        scopeId: scopeId || undefined,
        recipientId,
        spaceId: group.spaceId,
        projectId: group.projectId,
        pageId: group.pageId,
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
  scopeMeta?: {
    scopeId?: string;
    spaceId?: string | null;
    pageId?: string | null;
  },
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
  if (counts.mention)
    parts.push(`${counts.mention} mention${counts.mention > 1 ? 's' : ''}`);
  if (counts.comment)
    parts.push(`${counts.comment} comment${counts.comment > 1 ? 's' : ''}`);
  if (counts.reply)
    parts.push(`${counts.reply} repl${counts.reply > 1 ? 'ies' : 'y'}`);
  if (counts.suggestion)
    parts.push(
      `${counts.suggestion} suggestion${counts.suggestion > 1 ? 's' : ''}`,
    );

  const first = items[0];
  return {
    id: `digest-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    recipientId,
    scopeId: scopeMeta?.scopeId,
    spaceId: scopeMeta?.spaceId ?? first?.spaceId ?? null,
    projectId: projectId ?? first?.projectId,
    pageId: scopeMeta?.pageId ?? first?.pageId ?? null,
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
