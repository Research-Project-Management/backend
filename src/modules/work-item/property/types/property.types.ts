export const DEFAULT_FILTERS = {
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

export const DEFAULT_DISPLAY_FILTERS = {
  group_by: null,
  order_by: '-created_at',
  type: null,
  sub_issue: true,
  show_empty_groups: true,
  layout: 'list',
  calendar_date_range: '',
};

export const DEFAULT_DISPLAY_PROPERTIES = {
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

export const DEFAULT_PREFERENCES = {
  pages: { block_display: true },
  navigation: { default_tab: 'work_items', hide_in_more_menu: [] },
};

export interface ProjectUserPropertyData {
  id: string;
  projectId: string;
  userId: string;
  filters: Record<string, any>;
  displayFilters: Record<string, any>;
  displayProperties: Record<string, any>;
  richFilters: Record<string, any>;
  preferences: Record<string, any>;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
