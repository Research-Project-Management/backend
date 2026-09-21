/**
 * notification-bundler.types.ts
 *
 * Types and interfaces for Overleaf-style 10-minute notification bundling
 * and review digest aggregation across comments, @mentions, and track changes.
 */

export type BundledNotificationEventType =
  | 'mention'
  | 'comment'
  | 'reply'
  | 'suggestion';

export interface BundledNotificationItem {
  id: string;
  type: BundledNotificationEventType;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  pageId: string;
  pageTitle?: string;
  projectId?: string;
  targetId?: string;
  contentSnippet: string;
  line?: number;
  timestamp: string;
}

export interface NotificationBundle {
  recipientId: string;
  projectId?: string;
  pageId?: string;
  items: BundledNotificationItem[];
  createdAt: string;
  flushAt: string;
}

export interface NotificationDigestAuthorSummary {
  authorId: string;
  authorName: string;
  mentionCount: number;
  commentCount: number;
  replyCount: number;
  suggestionCount: number;
}

export interface NotificationDigest {
  id: string;
  recipientId: string;
  projectId?: string;
  summary: string;
  itemCount: number;
  mentionCount: number;
  commentCount: number;
  replyCount: number;
  suggestionCount: number;
  authorSummaries: NotificationDigestAuthorSummary[];
  items: BundledNotificationItem[];
  createdAt: string;
  windowMinutes: number;
}

export interface NotificationBundlingSettings {
  enabled: boolean;
  windowMinutes: number;
}

export const DEFAULT_BUNDLING_SETTINGS: NotificationBundlingSettings = {
  enabled: true,
  windowMinutes: 10,
};
