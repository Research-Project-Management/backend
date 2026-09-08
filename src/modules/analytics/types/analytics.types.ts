/**
 * Analytics Domain Types & Interfaces
 */

export interface ActivityFeedActor {
  name?: string | null;
  avatar?: string | null;
}

export interface ActivityFeedProject {
  id: string;
  name: string;
}

export interface ActivityFeedItem {
  id: string;
  entityType: string;
  verb: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  actorId: string;
  projectId?: string | null;
  createdAt: Date;
  entityId: string;
  actor?: ActivityFeedActor | null;
  project?: ActivityFeedProject | null;
}

export interface AssigneeDistributionItem {
  userId: string;
  name: string;
  avatar: string | null;
  count: number;
}

export interface ProjectDistributionResult {
  state: Record<string, number>;
  priority: Record<string, number>;
  assignee: AssigneeDistributionItem[];
}
