import { ViewAccess } from '@prisma/client';

export const DEFAULT_VIEW_FILTERS = {
  priority: null,
  state: null,
  state_group: null,
  assignees: null,
  created_by: null,
  labels: null,
  start_date: null,
  target_date: null,
  subscriber: null,
};

export const DEFAULT_VIEW_DISPLAY_FILTERS = {
  group_by: null,
  order_by: '-created_at',
  type: null,
  sub_issue: true,
  show_empty_groups: true,
  layout: 'list',
  calendar_date_range: '',
};

export const DEFAULT_VIEW_DISPLAY_PROPERTIES = {
  assignee: true,
  attachment_count: true,
  created_on: true,
  due_date: true,
  key: true,
  labels: true,
  link: true,
  priority: true,
  start_date: true,
  state: true,
  sub_issue_count: true,
  updated_on: true,
};

export interface ViewFilterQuery {
  columnId?: string | string[];
  priority?: string | string[];
  assigneeId?: string | string[];
  labels?: string[];
  cycleId?: string | null;
  search?: string;
  startDate?: string;
  dueDate?: string;
  completed?: boolean;
  [key: string]: any;
}

export interface ViewDisplayFilters {
  layout?: 'board' | 'list' | 'calendar' | 'table' | 'timeline' | 'kanban' | 'spreadsheet' | 'gantt_chart';
  groupBy?: string | null;
  orderBy?: string | null;
  sortOrder?: 'asc' | 'desc';
  subIssue?: boolean;
  showEmptyGroups?: boolean;
  [key: string]: any;
}

export interface ViewCreatorUser {
  id: string;
  name: string;
  avatar: string | null;
  email?: string | null;
}

export interface WorkItemViewItem {
  id: string;
  name: string;
  description: string | null;
  query: Record<string, any>;
  filters: Record<string, any>;
  displayFilters: Record<string, any>;
  displayProperties: Record<string, any>;
  richFilters: Record<string, any>;
  access: ViewAccess;
  sortOrder: number;
  logoProps: Record<string, any>;
  isLocked: boolean;
  archivedAt?: Date | null;
  projectId: string;
  createdById: string;
  createdBy?: ViewCreatorUser;
  isFavorite?: boolean;
  createdAt: Date;
  updatedAt: Date;
}
