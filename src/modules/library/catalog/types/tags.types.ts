export interface TagObjectInput {
  tag?: string;
  name?: string;
  type?: number | string;
}

export type TagInput = string | TagObjectInput;

export interface TagDetail {
  id: string;
  projectId?: string | null;
  name: string;
  color?: string | null;
  type?: string | null;
  shortcut?: number | null;
  userId?: string;
  createdById?: string | null;
  _count?: { itemTags: number };
  createdAt: Date;
  updatedAt: Date;
}

export type TagEntity = TagDetail;
