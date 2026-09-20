/**
 * Label Domain Repository Interface (Port)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { WorkItemLabel as Label, Prisma } from '@prisma/client';

export type LabelType = string;

export interface ILabelRepository {
  findUserLabels(
    userId: string,
    type?: LabelType,
    projectId?: string | null,
  ): Promise<Label[]>;
  findLabelById(labelId: string): Promise<Label | null>;
  createLabel(
    data:
      | Prisma.WorkItemLabelCreateInput
      | Prisma.WorkItemLabelUncheckedCreateInput,
  ): Promise<Label>;
  updateLabel(
    labelId: string,
    data:
      | Prisma.WorkItemLabelUpdateInput
      | Prisma.WorkItemLabelUncheckedUpdateInput,
  ): Promise<Label>;
  deleteLabel(labelId: string): Promise<Label>;
}
