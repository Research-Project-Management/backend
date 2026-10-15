import { BadRequestException } from '@nestjs/common';
import { WorkItemWithRelations } from '@/modules/work-item/core/types/work-item.types';

export const MAX_HIERARCHY_DEPTH = 10;

export async function validateHierarchyCycle(
  targetWorkItemId: string,
  initialParent: WorkItemWithRelations,
  findWorkItemById: (id: string) => Promise<WorkItemWithRelations | null>,
  maxDepth: number = MAX_HIERARCHY_DEPTH,
): Promise<void> {
  if (initialParent.id === targetWorkItemId) {
    throw new BadRequestException(
      'A work item cannot be set as its own parent',
    );
  }

  let curr: WorkItemWithRelations | null = initialParent;
  const visited = new Set<string>([targetWorkItemId, initialParent.id]);
  let depth = 1;

  while (curr && curr.parentWorkItemId) {
    if (visited.has(curr.parentWorkItemId)) {
      throw new BadRequestException(
        'Cannot set a descendant or cyclical ancestor as the parent work item',
      );
    }
    depth += 1;
    if (depth > maxDepth) {
      throw new BadRequestException(
        `Hierarchy depth cannot exceed ${maxDepth} levels`,
      );
    }
    visited.add(curr.parentWorkItemId);
    curr = await findWorkItemById(curr.parentWorkItemId);
  }
}
