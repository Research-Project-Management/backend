/**
 * Analytics Domain Types & Interfaces
 */

export * from '../your-work/types/your-work.types';

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
