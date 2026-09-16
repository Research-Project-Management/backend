import { ProjectPriority, ProjectState } from '@prisma/client';

export interface ProjectOverviewProjectDto {
  id: string;
  name: string;
  identifier: string;
  description: string | null;
  avatar: string | null;
  coverImage: string | null;
  state: ProjectState;
  priority: ProjectPriority;
  startDate: Date | null;
  targetDate: Date | null;
  totalMembers: number;
  lead: {
    id: string;
    name: string | null;
    avatar: string | null;
  } | null;
}

export interface ProjectOverviewLinkDto {
  id: string;
  projectId: string;
  title: string;
  url: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectOverviewMetricsDto {
  totalIssues: number;
  completed: number;
  started: number;
  unstarted: number;
  backlog: number;
  overdue: number;
  completionPercentage: number;
}

export interface ProjectOverviewActiveCycleDto {
  id: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  totalIssues: number;
  completedIssues: number;
  completionPercentage: number;
}

export interface ProjectOverviewActivityDto {
  id: string;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  oldIdentifier: string | null;
  newIdentifier: string | null;
  createdAt: Date;
  actor: {
    id: string;
    name: string | null;
    avatar: string | null;
  };
}

export interface ProjectOverviewResponseDto {
  project: ProjectOverviewProjectDto;
  links: ProjectOverviewLinkDto[];
  metrics: ProjectOverviewMetricsDto;
  activeCycle: ProjectOverviewActiveCycleDto | null;
  recentActivities: ProjectOverviewActivityDto[];
}
