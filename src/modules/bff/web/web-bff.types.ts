/**
 * modules/bff/web/web-bff.types.ts
 * Typed response contracts tailored for Web Desktop screens.
 */

import type { EnrichedProject } from '@/modules/project/core/types/project.type';
import type { ProjectOverviewResponseDto } from '@/modules/project/overview/dto/project-overview-response.dto';
import type { YourWorkSummaryDto } from '@/modules/project/your-work/dto/your-work.dto';
import type { EditorBootstrapResponseDto } from '@/modules/pages/bootstrap/editor-bootstrap.types';

export interface WebWorkspaceProjectsSummary {
  items: EnrichedProject[];
  myProjects: EnrichedProject[];
  sharedProjects: EnrichedProject[];
  total: number;
}

export interface WebWorkspaceChatSummary {
  totalConversations: number;
  totalUnreadCount: number;
}

export interface WebWorkspaceShellData {
  projects: WebWorkspaceProjectsSummary;
  yourWork: YourWorkSummaryDto | null;
  chat: WebWorkspaceChatSummary;
}

export interface WebProjectChannelSummary {
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

export interface WebProjectBootstrapData {
  overview: ProjectOverviewResponseDto;
  channels: WebProjectChannelSummary[];
}

export type WebEditorBootstrapData = EditorBootstrapResponseDto;
