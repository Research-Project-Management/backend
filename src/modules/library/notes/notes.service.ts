import { Injectable, Logger } from '@nestjs/common';
import {
  NotesRepository,
  CreateNoteData,
  UpdateNoteData,
} from './notes.repository';
import { LibraryTransactionService } from '../sync/library-transaction.service';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(
    private readonly notesRepo: NotesRepository,
    private readonly libraryTx: LibraryTransactionService,
  ) {}

  async listNotes(workspaceId: string, itemId?: string) {
    return this.notesRepo.findMany(workspaceId, itemId);
  }

  async getNote(workspaceId: string, id: string) {
    return this.notesRepo.findById(workspaceId, id);
  }

  async createNote(workspaceId: string, data: CreateNoteData) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const note = await this.notesRepo.create(workspaceId, data, tx);

      await helpers.appendChange(workspaceId, {
        entityType: 'Note',
        entityId: note.id,
        action: 'create',
        version: note.version,
        data: note,
      });

      await helpers.publishOutbox(
        workspaceId,
        note.id,
        'library.note.created',
        note,
      );

      return note;
    });
  }

  async updateNote(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateNoteData,
  ) {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const updated = await this.notesRepo.update(
        workspaceId,
        id,
        expectedVersion,
        data,
        tx,
      );

      await helpers.appendChange(workspaceId, {
        entityType: 'Note',
        entityId: updated.id,
        action: 'update',
        version: updated.version,
        data: updated,
      });

      await helpers.publishOutbox(
        workspaceId,
        updated.id,
        'library.note.updated',
        updated,
      );

      return updated;
    });
  }

  async deleteNote(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<boolean> {
    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const deleted = await this.notesRepo.softDelete(
        workspaceId,
        id,
        expectedVersion,
        tx,
      );

      if (deleted) {
        await helpers.recordTombstone(workspaceId, {
          entityType: 'Note',
          entityId: id,
        });

        await helpers.publishOutbox(workspaceId, id, 'library.note.deleted', {
          id,
          deletedAt: new Date(),
        });
      }

      return deleted;
    });
  }
}
