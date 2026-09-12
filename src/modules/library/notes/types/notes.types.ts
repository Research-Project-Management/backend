import { Note as PrismaNote } from '@prisma/client';

export type NoteEntity = PrismaNote;

export interface CreateNoteData {
  projectId?: string;
  workspaceId?: string;
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
