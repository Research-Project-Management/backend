/**
 * Your Work Domain Types & Interfaces
 */

import { Task } from '@prisma/client';
import type { StateGroup } from '@/modules/work-item/state/types/state.types';

export interface ProjectWorkloadBreakdown {
  projectId: string;
  projectName: string;
  projectIdentifier: string | null;
  projectAvatar: string | null;
  assignedCount: number;
  createdCount: number;
  subscribedCount: number;
  totalCount: number;
  stateGroupBreakdown: Record<StateGroup, number>;
  subscribedStateGroupBreakdown: Record<StateGroup, number>;
  completionRate: number;
}

export interface UserProfileData {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  createdAt: Date | string;
}

export interface UserMinimal {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export interface ProjectMinimal {
  id: string;
  name: string;
  avatar: string | null;
  identifier: string | null;
  taskColumns?: unknown;
}

export interface TaskCommentMinimal {
  id: string;
}

export interface UserWorkspaceTaskItem extends Task {
  author: UserMinimal;
  assignee: UserMinimal | null;
  project: ProjectMinimal;
  comments: TaskCommentMinimal[];
}

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

export interface YourWorkActivityItem {
  id: string;
  type: string;
  actorName: string;
  actionVerb: string;
  targetIdentifier: string | null;
  targetTitle: string;
  content: string;
  time: string;
  itemId: string;
  user?: {
    name: string;
    avatar: string | null;
  };
  project?: {
    id: string;
    name: string;
  };
}

export interface IYourWorkRepository {
  findUserWorkspaceTasks(
    workspaceId: string,
    userId: string,
  ): Promise<UserWorkspaceTaskItem[]>;
  findUserProfile(userId: string): Promise<UserProfileData | null>;
  findUserWorkspaceProjects(
    workspaceId: string,
    userId: string,
  ): Promise<ProjectMinimal[]>;
}
