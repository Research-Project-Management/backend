/**
 * Label Domain Types & Repository Port (Hexagonal / DDD-Lite)
 *
 * Scoped to Project or User,
 * parent-child nesting hierarchy, and safe work item detachment.
 */

import { WorkItemLabel as Label, Prisma } from '@prisma/client';

export type LabelType = string;

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
  findProjectLabels(
    projectId: string,
    type?: LabelType,
  ): Promise<LabelWithChildren[]>;
  findUserLabels(
    userId: string,
    type?: LabelType,
    projectId?: string | null,
  ): Promise<Label[]>;
  findById(labelId: string): Promise<LabelWithChildren | null>;
  findByNameInProject(
    projectId: string,
    name: string,
    excludeId?: string,
  ): Promise<Label | null>;
  create(data: Prisma.WorkItemLabelUncheckedCreateInput): Promise<Label>;
  createMany?(
    data: Prisma.WorkItemLabelUncheckedCreateInput[],
  ): Promise<{ count: number }>;
  update(
    labelId: string,
    data: Prisma.WorkItemLabelUncheckedUpdateInput,
  ): Promise<Label>;
  delete(labelId: string): Promise<Label>;
  reorder(projectId: string, updates: ReorderLabelItem[]): Promise<void>;
  detachFromWorkItems(
    projectId: string,
    labelId: string,
    labelName?: string,
  ): Promise<number>;
  detachMultipleFromWorkItems(
    projectId: string,
    labelIds: string[],
    labelNames?: string[],
  ): Promise<number>;
  detachFromPages(projectId: string, labelId: string): Promise<number>;
  detachMultipleFromPages(
    projectId: string,
    labelIds: string[],
  ): Promise<number>;
}
