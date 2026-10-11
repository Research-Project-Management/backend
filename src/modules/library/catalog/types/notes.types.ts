export interface NoteEntity {
  id: string;
  projectId?: string | null;
  itemId?: string | null;
  title: string;
  contentJson?: unknown;
  contentMd?: string | null;
  tags?: string[];
  createdById?: string | null;
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
  createdById?: string;
}

export type { FormatNoteOptions } from '../utils/notes.utils';

export interface UpdateNoteData {
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  expectedVersion?: number;
}

export interface ExtractLiteratureNoteResult {
  success: boolean;
  totalExtracted: number;
  message?: string;
  literatureNote?: NoteEntity;
}
