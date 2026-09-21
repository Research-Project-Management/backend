import { Injectable, Logger } from '@nestjs/common';
import { NotesService } from '../services/notes.service';

export interface DeleteNoteCommand {
  userId: string;
  id: string;
  expectedVersion?: number;
  projectId?: string;
}

@Injectable()
export class DeleteNoteUseCase {
  private readonly logger = new Logger(DeleteNoteUseCase.name);

  constructor(private readonly notesService: NotesService) {}

  async execute(command: DeleteNoteCommand): Promise<boolean> {
    this.logger.debug(
      `Deleting note ${command.id} for user ${command.userId}`,
    );
    return this.notesService.deleteNote(
      command.userId,
      command.id,
      command.expectedVersion,
      command.projectId,
    );
  }
}
