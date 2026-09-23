/**
 * modules/manuscripts/structure/core/ports/tree-publisher.port.ts
 * Port interface for broadcasting file-tree mutations (create, move, rename, delete)
 * to real-time collaboration rooms via WebSockets or in-memory bus.
 */

export interface TreeMutationPayload {
  projectId: string;
  action: 'create' | 'move' | 'rename' | 'delete' | 'root_doc_changed' | 'reorder';
  nodeId: string;
  path?: string;
  oldPath?: string;
  entityType?: string;
  data?: any;
}

export abstract class ITreePublisher {
  abstract publishTreeMutation(payload: TreeMutationPayload): Promise<void>;
}
