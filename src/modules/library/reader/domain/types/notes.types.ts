export interface NoteEntity {
  id: string;
  projectId?: string | null;
  itemId?: string | null;
  title: string;
  contentJson?: unknown;
  contentMd?: string | null;
  tags?: string[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateNoteData {
  projectId?: string;
  itemId?: string | null;
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  createdById: string;
}

export interface UpdateNoteData {
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
}

export interface ExtractLiteratureNoteResult {
  success: boolean;
  totalExtracted: number;
  message?: string;
  literatureNote?: NoteEntity;
}
