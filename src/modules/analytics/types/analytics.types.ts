/**
 * Analytics Domain Types & Interfaces
 */

export interface AssigneeDistributionItem {
  userId: string;
  name: string;
  avatar: string | null;
  count: number;
}

export interface ProjectDistributionResult {
  totalItems: number;
  completedItems: number;
  completionRate: number;
  state: Record<string, number>;
  priority: Record<string, number>;
  assignee: AssigneeDistributionItem[];
}
