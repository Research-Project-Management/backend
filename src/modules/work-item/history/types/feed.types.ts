export type FeedItemType =
  | 'comment'
  | 'activity'
  | 'transition'
  | 'history'
  | 'worklog';

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
  comment?: any;
  activity?: any;
  transition?: any;
  history?: any;
  worklog?: any;
}

export interface UnifiedFeedResponse {
  taskId: string;
  tab: string;
  sort: 'asc' | 'desc';
  total: number;
  feed: UnifiedFeedItem[];
  activities?: any[];
  comments?: any[];
}
