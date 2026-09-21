import { Injectable, Logger } from '@nestjs/common';
import { NotesService } from '../services/notes.service';
import { UpdateNoteData } from '../../domain/types/notes.types';

export interface UpdateNoteCommand {
  userId: string;
  id: string;
  expectedVersion: number;
  data: UpdateNoteData;
  projectId?: string;
}

@Injectable()
export class UpdateNoteUseCase {
  private readonly logger = new Logger(UpdateNoteUseCase.name);

  constructor(private readonly notesService: NotesService) {}

  async execute(command: UpdateNoteCommand) {
    this.logger.debug(
      `Updating note ${command.id} for user ${command.userId}`,
    );
    return this.notesService.updateNote(
      command.userId,
      command.id,
      command.expectedVersion,
      command.data,
      command.projectId,
    );
  }
}
