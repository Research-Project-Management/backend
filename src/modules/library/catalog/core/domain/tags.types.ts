export interface TagObjectInput {
  tag?: string;
  name?: string;
}

export type TagInput = string | TagObjectInput;

export interface TagDetail {
  id: string;
  projectId?: string;
  name: string;
  color?: string | null;
  type?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
