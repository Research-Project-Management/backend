import { BadRequestException } from '@nestjs/common';
import { WorkItemWithRelations } from '../types/work-item.types';

export async function validateHierarchyCycle(
  targetWorkItemId: string,
  initialParent: WorkItemWithRelations,
  findWorkItemById: (id: string) => Promise<WorkItemWithRelations | null>,
): Promise<void> {
  let curr: WorkItemWithRelations | null = initialParent;
  const visited = new Set<string>([targetWorkItemId]);

  while (curr && curr.parentWorkItemId) {
    if (visited.has(curr.parentWorkItemId)) {
      throw new BadRequestException(
        'Cannot set a descendant or cyclical ancestor as the parent work item',
      );
    }
    visited.add(curr.parentWorkItemId);
    curr = await findWorkItemById(curr.parentWorkItemId);
  }
}
