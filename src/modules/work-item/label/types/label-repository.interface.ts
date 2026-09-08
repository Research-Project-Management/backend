/**
 * Label Domain Repository Interface (Port)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { Label, LabelType, Prisma } from '@prisma/client';

export interface ILabelRepository {
  findWorkspaceLabels(workspaceId: string, type?: LabelType): Promise<Label[]>;
  findLabelById(labelId: string): Promise<Label | null>;
  createLabel(
    data: Prisma.LabelCreateInput | Prisma.LabelUncheckedCreateInput,
  ): Promise<Label>;
  updateLabel(
    labelId: string,
    data: Prisma.LabelUpdateInput | Prisma.LabelUncheckedUpdateInput,
    workspaceId?: string,
  ): Promise<Label>;
  deleteLabel(labelId: string, workspaceId?: string): Promise<Label>;
}
