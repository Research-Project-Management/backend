/**
 * Label Domain Types
 *
 * Scoped to Project or User,
 * parent-child nesting hierarchy, and safe work item detachment.
 */

import { WorkItemLabel as Label } from '@prisma/client';

export type LabelType = string;

export interface LabelWithChildren extends Label {
  children?: Label[];
  parent?: Label | null;
}

export interface ReorderLabelItem {
  id: string;
  sortOrder: number;
}
