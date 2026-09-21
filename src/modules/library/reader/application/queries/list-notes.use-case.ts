import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  NOTE_REPOSITORY_PORT,
  INoteRepositoryPort,
} from '../../domain/ports/note-repository.port';
import { NotesService } from '../services/notes.service';

export interface ListNotesQuery {
  userId: string;
  itemId?: string;
  projectId?: string;
}

@Injectable()
export class ListNotesUseCase {
  private readonly logger = new Logger(ListNotesUseCase.name);

  constructor(
    @Optional()
    @Inject(NOTE_REPOSITORY_PORT)
    private readonly noteRepo?: INoteRepositoryPort,
    @Optional()
    private readonly notesService?: NotesService,
  ) {}

  async execute(query: ListNotesQuery): Promise<any>;
  async execute(userId: string, itemId?: string, projectId?: string): Promise<any>;
  async execute(first: ListNotesQuery | string, second?: string, third?: string): Promise<any> {
    const userId = typeof first === 'string' ? first : first.userId;
    const itemId = typeof first === 'string' ? second : first.itemId;
    const projectId = typeof first === 'string' ? third : first.projectId;

    if (this.notesService) {
      return this.notesService.listNotes(userId, itemId, projectId);
    }

    if (this.noteRepo) {
      return this.noteRepo.findMany(userId, { itemId });
    }

    throw new Error('Neither NotesService nor INoteRepositoryPort is available in ListNotesUseCase');
  }
}
