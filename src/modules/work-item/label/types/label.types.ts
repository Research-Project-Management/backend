/**
 * Label Domain Types & Repository Port (Hexagonal / DDD-Lite)
 *
 * Scoped to Project with Workspace isolation,
 * parent-child nesting hierarchy, and safe task detachment.
 */

import { Label, LabelType, Prisma } from '@prisma/client';

export interface LabelWithChildren extends Label {
  children?: Label[];
  parent?: Label | null;
}

export interface ReorderLabelItem {
  id: string;
  sortOrder: number;
}

export interface ImportLabelRow {
  name: string;
  color?: string;
  description?: string;
}

export interface ImportLabelResult {
  created: number;
  skipped: number;
  failed: number;
  labels: Label[];
}

export interface ILabelRepository {
  findProjectLabels(projectId: string): Promise<LabelWithChildren[]>;
  findWorkspaceLabels(workspaceId: string, type?: LabelType): Promise<Label[]>;
  findById(labelId: string): Promise<LabelWithChildren | null>;
  findByNameInProject(
    projectId: string,
    name: string,
    excludeId?: string,
  ): Promise<Label | null>;
  create(data: Prisma.LabelUncheckedCreateInput): Promise<Label>;
  createMany?(
    data: Prisma.LabelUncheckedCreateInput[],
  ): Promise<{ count: number }>;
  update(
    labelId: string,
    data: Prisma.LabelUncheckedUpdateInput,
  ): Promise<Label>;
  delete(labelId: string): Promise<Label>;
  reorder(projectId: string, updates: ReorderLabelItem[]): Promise<void>;
  detachFromTasks(
    projectId: string,
    labelId: string,
    labelName?: string,
  ): Promise<number>;
  detachMultipleFromTasks(
    projectId: string,
    labelIds: string[],
    labelNames?: string[],
  ): Promise<number>;
}
