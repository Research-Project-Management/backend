/**
 * Project Overview Domain Types & Interfaces
 */

import { ProjectPriority, ProjectState, Role } from '@prisma/client';

export interface OverviewRawMetadata {
  id: string;
  name: string;
  identifier: string;
  description: string | null;
  avatar: string | null;
  coverImage: string | null;
  stateId?: string | null;
  state: ProjectState | null;
  priority: ProjectPriority;
  startDate: Date | null;
  targetDate: Date | null;
  createdBy?: {
    id: string;
    profile?: {
      name: string | null;
      avatar: string | null;
    } | null;
  } | null;
  members?: Array<{
    userId: string;
    role: Role | string;
    user?: {
      id: string;
      profile?: {
        name: string | null;
        avatar: string | null;
      } | null;
    } | null;
  }>;
  _count?: {
    members?: number;
  };
}

export interface OverviewRawActivity {
  id: string;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  oldIdentifier: string | null;
  newIdentifier: string | null;
  createdAt: Date;
  actor?: {
    id: string;
    profile?: {
      name: string | null;
      avatar: string | null;
    } | null;
  } | null;
}

export interface OverviewRawStatusUpdate {
  id: string;
  status: 'on_track' | 'at_risk' | 'off_track';
  message: string;
  createdAt: Date;
  createdBy: {
    id: string;
    profile?: {
      name: string | null;
      avatar: string | null;
    } | null;
  };
}

export interface ProjectOverviewAssets {
  pagesCount: number;
  libraryCount: number;
  filesCount?: number;
}
