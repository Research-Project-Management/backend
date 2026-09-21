import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  NOTE_REPOSITORY_PORT,
  INoteRepositoryPort,
} from '../../domain/ports/note-repository.port';
import { NotesService } from '../services/notes.service';

export interface GetNoteQuery {
  userId: string;
  id: string;
  projectId?: string;
}

@Injectable()
export class GetNoteUseCase {
  private readonly logger = new Logger(GetNoteUseCase.name);

  constructor(
    @Optional()
    @Inject(NOTE_REPOSITORY_PORT)
    private readonly noteRepo?: INoteRepositoryPort,
    @Optional()
    private readonly notesService?: NotesService,
  ) {}

  async execute(query: GetNoteQuery): Promise<any>;
  async execute(userId: string, id: string, projectId?: string): Promise<any>;
  async execute(first: GetNoteQuery | string, second?: string, third?: string): Promise<any> {
    const userId = typeof first === 'string' ? first : first.userId;
    const id = typeof first === 'string' ? second! : first.id;
    const projectId = typeof first === 'string' ? third : first.projectId;

    if (this.notesService) {
      return this.notesService.getNote(userId, id, projectId);
    }

    if (this.noteRepo) {
      return this.noteRepo.findById(id, userId);
    }

    throw new Error('Neither NotesService nor INoteRepositoryPort is available in GetNoteUseCase');
  }
}
