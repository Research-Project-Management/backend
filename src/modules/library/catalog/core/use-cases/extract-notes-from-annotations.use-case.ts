import { Injectable, Logger } from '@nestjs/common';
import { NotesService } from './notes.service';

import { FormatNoteOptions } from '../adapters/notes.utils';

export interface ExtractNotesFromAnnotationsCommand {
  userId: string;
  itemId: string;
  options?: FormatNoteOptions;
}

@Injectable()
export class ExtractNotesFromAnnotationsUseCase {
  private readonly logger = new Logger(ExtractNotesFromAnnotationsUseCase.name);

  constructor(private readonly notesService: NotesService) {}

  async execute(command: ExtractNotesFromAnnotationsCommand) {
    this.logger.debug(
      `Extracting notes from annotations for item ${command.itemId} (user: ${command.userId})`,
    );
    return this.notesService.extractNotesFromAnnotations(
      command.userId,
      command.itemId,
      command.options,
    );
  }
}
