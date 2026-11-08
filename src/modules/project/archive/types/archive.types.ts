/**
 * Project Archive Domain Types & Interfaces
 */

import {
  EnrichedProject,
  ProjectWithMembers,
} from '../../core/types/project.type';

export type { EnrichedProject, ProjectWithMembers };

export interface ProjectLookupSummary {
  id: string;
  name: string;
  identifier: string | null;
  isArchived: boolean;
  isActive: boolean;
}

export interface ArchivedWorkItemSummary {
  id: string;
  identifier: string | null;
  title: string;
  priority: string | null;
  stateId: string | null;
  stateGroup: string | null;
  completed: boolean;
  archivedAt: Date | string | null;
  updatedAt: Date | string;
  projectId: string;
  assignee: {
    id: string;
    email: string | null;
    name: string | null;
    avatar: string | null;
  } | null;
}

export interface ArchivedPageSummary {
  id: string;
  title: string;
  description: string;
  status: string;
  path: string;
  projectId: string;
  version: number;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectScopedArchivesResult {
  projectId: string;
  workItems: ArchivedWorkItemSummary[];
  pages: ArchivedPageSummary[];
  counts: {
    workItems: number;
    pages: number;
    total: number;
  };
}
