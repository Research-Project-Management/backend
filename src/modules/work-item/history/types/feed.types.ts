import type { StateTransitionItem } from './transition.types';
import type { PropertyHistoryItem } from './history.types';

export type FeedItemType = 'comment' | 'activity' | 'transition' | 'history';

export interface FeedActor {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
}

export interface UnifiedFeedItem {
  id: string;
  type: FeedItemType;
  timestamp: Date;
  actor?: FeedActor | null;
  comment?: Record<string, unknown> | null;
  activity?: Record<string, unknown> | null;
  transition?: StateTransitionItem | null;
  history?: PropertyHistoryItem | null;
}

export interface UnifiedFeedResponse {
  workItemId: string;
  tab: string;
  sort: 'asc' | 'desc';
  total: number;
  feed: UnifiedFeedItem[];
  activities?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
}
