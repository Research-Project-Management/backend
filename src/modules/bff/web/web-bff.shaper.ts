/**
 * modules/bff/web/web-bff.shaper.ts
 * Subsystem 3 (Data Shaping & Translation):
 * Pure, side-effect-free functions transforming domain models into
 * Web-optimized payloads (trimming duplicate fields, flattening summaries).
 */

import type { EnrichedProject } from '@/modules/project/core/types/project.type';
import type {
  WebProjectChannelSummary,
  WebWorkspaceChatSummary,
  WebWorkspaceProjectsSummary,
} from './web-bff.types';

export interface ConversationBucketInput {
  directs: ReadonlyArray<{ unreadCount: number }>;
  groups: ReadonlyArray<{ unreadCount: number }>;
  projectChannels: ReadonlyArray<{ unreadCount: number }>;
}

export interface ProjectChannelRawInput {
  id: string;
  name: string | null;
  topic: string | null;
  isDefault: boolean;
  memberCount: number;
  unreadCount: number;
  isMuted: boolean;
  isPinned: boolean;
  updatedAt: string;
}

export function shapeWebWorkspaceProjects(input: {
  projects: EnrichedProject[];
  myProjects: EnrichedProject[];
  sharedProjects: EnrichedProject[];
  total: number;
}): WebWorkspaceProjectsSummary {
  return {
    items: input.projects,
    myProjects: input.myProjects,
    sharedProjects: input.sharedProjects,
    total: input.total,
  };
}

export function shapeWebWorkspaceChatSummary(
  buckets: ConversationBucketInput,
): WebWorkspaceChatSummary {
  const all = [
    ...buckets.directs,
    ...buckets.groups,
    ...buckets.projectChannels,
  ];
  let totalUnreadCount = 0;

  for (const conv of all) {
    if (typeof conv.unreadCount === 'number' && conv.unreadCount > 0) {
      totalUnreadCount += conv.unreadCount;
    }
  }

  return {
    totalConversations: all.length,
    totalUnreadCount,
  };
}

export function shapeWebProjectChannels(
  channels: ReadonlyArray<ProjectChannelRawInput>,
): WebProjectChannelSummary[] {
  return channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    topic: ch.topic,
    isDefault: ch.isDefault,
    memberCount: ch.memberCount,
    unreadCount: ch.unreadCount,
    isMuted: ch.isMuted,
    isPinned: ch.isPinned,
    updatedAt: ch.updatedAt,
  }));
}
