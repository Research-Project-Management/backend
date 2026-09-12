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
  state: Record<string, number>;
  priority: Record<string, number>;
  assignee: AssigneeDistributionItem[];
}
