import { ConflictException } from '@nestjs/common';
import { ApplyExternalSyncBatchCommand } from '../ports/sync.port';

/**
 * Topologically sorts upsertCollection operations so that parent collections
 * are processed before their children within the same batch.
 * Non-collection operations retain their original relative order after collections.
 * Throws ConflictException if a circular dependency is detected.
 */
export function topoSortOperations(
  operations: ApplyExternalSyncBatchCommand['operations'],
): ApplyExternalSyncBatchCommand['operations'] {
  const colOps = operations.filter((op) => op.op === 'upsertCollection');
  const otherOps = operations.filter((op) => op.op !== 'upsertCollection');

  if (colOps.length === 0) return operations;

  // Build a map: operationId -> op, and determine edges (parentRef -> operationId)
  const byOpId = new Map(
    colOps.filter((op) => op.operationId).map((op) => [op.operationId!, op]),
  );

  // Kahn's algorithm for topological sort
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>(); // parentOpId -> [childOpIds]

  for (const op of colOps) {
    if (op.operationId && !inDegree.has(op.operationId)) {
      inDegree.set(op.operationId, 0);
    }
  }

  for (const op of colOps) {
    if (op.parentRef && op.operationId && byOpId.has(op.parentRef)) {
      const kids = children.get(op.parentRef) ?? [];
      kids.push(op.operationId);
      children.set(op.parentRef, kids);
      inDegree.set(op.operationId, (inDegree.get(op.operationId) ?? 0) + 1);
    }
    // If parentRef is set but NOT in this batch, it is a cross-batch reference —
    // the parent must already exist in the DB (resolved via existingId before tx).
  }

  const queue: string[] = [];
  for (const [opId, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(opId);
  }
  // Include ops without operationId — they go first (no ordering constraint)
  const noIdOps = colOps.filter((op) => !op.operationId);

  const sorted: ApplyExternalSyncBatchCommand['operations'] = [...noIdOps];
  let processed = 0;

  while (queue.length > 0) {
    const opId = queue.shift()!;
    const op = byOpId.get(opId);
    if (op) {
      sorted.push(op);
      processed++;
    }
    for (const childId of children.get(opId) ?? []) {
      const newDeg = (inDegree.get(childId) ?? 1) - 1;
      inDegree.set(childId, newDeg);
      if (newDeg === 0) queue.push(childId);
    }
  }

  // If we could not process all ops with operationIds, there is a cycle
  if (processed !== byOpId.size) {
    throw new ConflictException(
      'Circular collection hierarchy detected in batch operations. ' +
        'Collections cannot be their own ancestors.',
    );
  }

  // Non-collection ops after all collections
  return [...sorted, ...otherOps];
}

/**
 * Computes a deterministic SHA-256 hash for a sync batch request.
 * Used for idempotency checks so duplicate batch submissions are detected.
 */
export function computeRequestHash(input: object): string {
  const { createHash } = require('crypto');
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
