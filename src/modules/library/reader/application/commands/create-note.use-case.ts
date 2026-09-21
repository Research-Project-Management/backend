import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  NOTE_REPOSITORY_PORT,
  INoteRepositoryPort,
} from '../../domain/ports/note-repository.port';
import { NoteEntity } from '../../domain/model/note.entity';
import { NotesService } from '../services/notes.service';
import { CreateNoteData } from '../../domain/types/notes.types';

export interface CreateNoteCommand {
  userId: string;
  data: CreateNoteData;
  projectId?: string;
}

@Injectable()
export class CreateNoteUseCase {
  private readonly logger = new Logger(CreateNoteUseCase.name);

  constructor(
    @Optional()
    @Inject(NOTE_REPOSITORY_PORT)
    private readonly noteRepo?: INoteRepositoryPort,
    @Optional()
    private readonly notesService?: NotesService,
  ) {}

  async execute(command: CreateNoteCommand): Promise<any>;
  async execute(userId: string, data: CreateNoteData): Promise<any>;
  async execute(first: CreateNoteCommand | string, second?: CreateNoteData): Promise<any> {
    const userId = typeof first === 'string' ? first : first.userId;
    const data = typeof first === 'string' ? second! : first.data;
    const projectId = typeof first === 'string' ? second?.projectId : (first.projectId ?? first.data?.projectId);

    const effectiveData: CreateNoteData = {
      ...data,
      projectId: projectId || data?.projectId,
    };

    if (this.notesService) {
      return this.notesService.createNote(userId, effectiveData);
    }

    if (this.noteRepo) {
      this.logger.debug(`Creating note via domain port for user ${userId}`);
      const entity = NoteEntity.create({
        itemId: effectiveData.itemId ?? '',
        userId,
        title: effectiveData.title,
        content: effectiveData.contentMd,
      });
      await this.noteRepo.save(entity);
      return entity;
    }

    throw new Error('Neither NotesService nor INoteRepositoryPort is available in CreateNoteUseCase');
  }
}
