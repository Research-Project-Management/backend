export interface NoteDetail {
  id: string;
  workspaceId: string;
  itemId?: string | null;
  title?: string | null;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string | null;
  tags: string[];
  version: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNoteInput {
  workspaceId: string;
  itemId?: string | null;
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  createdById: string;
}

export interface UpdateNoteInput {
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
}
