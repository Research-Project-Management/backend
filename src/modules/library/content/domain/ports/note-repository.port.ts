import { NoteEntity } from '../model/note.entity';

export const NOTE_REPOSITORY_PORT = Symbol('NOTE_REPOSITORY_PORT');

export interface FindNotesOptions {
  itemId?: string;
  parentId?: string | null;
  includeDeleted?: boolean;
}

export interface INoteRepositoryPort {
  findById(noteId: string, userId: string): Promise<NoteEntity | null>;

  findMany(userId: string, options: FindNotesOptions): Promise<NoteEntity[]>;

  save(entity: NoteEntity): Promise<void>;

  delete(noteId: string, userId: string): Promise<boolean>;
}
