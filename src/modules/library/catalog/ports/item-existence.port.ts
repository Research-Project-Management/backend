export interface IItemExistencePort {
  exists(workspaceId: string, itemId: string): Promise<boolean>;
  assertExists(workspaceId: string, itemId: string): Promise<void>;
  existMany(workspaceId: string, itemIds: string[]): Promise<Map<string, boolean>>;
}

export const ITEM_EXISTENCE_PORT = Symbol('ITEM_EXISTENCE_PORT');
