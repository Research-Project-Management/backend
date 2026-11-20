export const WORK_ITEMS_ACCESS_PORT = Symbol('WORK_ITEMS_ACCESS_PORT');

export interface WorkItemsAccessPort {
  getRole(projectId: string, userId: string): Promise<string | null>;
  invalidateAccessCache(projectId: string, userId: string): Promise<void>;
}
