import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ItemsRepository } from '../items/items.repository';
import { LibraryNote } from './types/notes.types';
import { CreateNoteDto, UpdateNoteDto } from './dto/notes.dto';
import { parseItemNotes } from './utils/notes.util';

@Injectable()
export class NotesService {
  private readonly standaloneNotes = new Map<string, LibraryNote[]>();

  constructor(private readonly itemsRepo: ItemsRepository) {}

  async getNotes(workspaceId: string, itemId?: string): Promise<LibraryNote[]> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    if (itemId) {
      const item = await this.itemsRepo.findItemByIdInWorkspace(
        targetWsId,
        itemId,
      );
      if (!item || item.deletedAt) {
        throw new NotFoundException('Catalog item not found');
      }
      return parseItemNotes(item.id, item.notes);
    }

    const standalone = this.standaloneNotes.get(targetWsId) || [];
    const items = await this.itemsRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    const childNotes = items.flatMap((it: any) =>
      parseItemNotes(it.id, it.notes),
    );
    return [...standalone, ...childNotes];
  }

  async createNote(
    workspaceId: string,
    dto: CreateNoteDto,
    authorId?: string,
  ): Promise<LibraryNote> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    const now = new Date().toISOString();

    const note: LibraryNote = {
      id: randomUUID(),
      itemId: dto.itemId || null,
      title: dto.title || 'Untitled Note',
      content: dto.content || '',
      tags: dto.tags || [],
      version: 1,
      authorId,
      createdAt: now,
      updatedAt: now,
    };

    if (dto.itemId) {
      const item = await this.itemsRepo.findItemByIdInWorkspace(
        targetWsId,
        dto.itemId,
      );
      if (!item || item.deletedAt) {
        throw new NotFoundException('Catalog item not found');
      }
      const existing = parseItemNotes(item.id, item.notes);
      existing.push(note);
      await this.itemsRepo.updateItem(item.id, { notes: existing as any });
    } else {
      const list = this.standaloneNotes.get(targetWsId) || [];
      list.push(note);
      this.standaloneNotes.set(targetWsId, list);
    }

    return note;
  }

  async updateNote(
    workspaceId: string,
    noteId: string,
    dto: UpdateNoteDto,
  ): Promise<LibraryNote> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    const standaloneList = this.standaloneNotes.get(targetWsId) || [];
    const standaloneIdx = standaloneList.findIndex((n) => n.id === noteId);
    if (standaloneIdx >= 0) {
      const existing = standaloneList[standaloneIdx];
      const updated: LibraryNote = {
        ...existing,
        title: dto.title !== undefined ? dto.title : existing.title,
        content: dto.content !== undefined ? dto.content : existing.content,
        tags: dto.tags !== undefined ? dto.tags : existing.tags,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      standaloneList[standaloneIdx] = updated;
      this.standaloneNotes.set(targetWsId, standaloneList);
      return updated;
    }

    const items = await this.itemsRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    for (const item of items) {
      const notes = parseItemNotes(item.id, item.notes);
      const noteIdx = notes.findIndex((n: LibraryNote) => n.id === noteId);
      if (noteIdx >= 0) {
        const existing = notes[noteIdx];
        const updated: LibraryNote = {
          ...existing,
          title: dto.title !== undefined ? dto.title : existing.title,
          content: dto.content !== undefined ? dto.content : existing.content,
          tags: dto.tags !== undefined ? dto.tags : existing.tags,
          version: existing.version + 1,
          updatedAt: new Date().toISOString(),
        };
        notes[noteIdx] = updated;
        await this.itemsRepo.updateItem(item.id, { notes: notes as any });
        return updated;
      }
    }

    throw new NotFoundException('Note not found in this workspace');
  }

  async deleteNote(workspaceId: string, noteId: string): Promise<boolean> {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    const standaloneList = this.standaloneNotes.get(targetWsId) || [];
    const filteredStandalone = standaloneList.filter(
      (n: LibraryNote) => n.id !== noteId,
    );
    if (filteredStandalone.length !== standaloneList.length) {
      this.standaloneNotes.set(targetWsId, filteredStandalone);
      return true;
    }

    const items = await this.itemsRepo.findItems({
      workspaceId: targetWsId,
      deletedAt: null,
    });

    for (const item of items) {
      const notes = parseItemNotes(item.id, item.notes);
      const filtered = notes.filter((n: LibraryNote) => n.id !== noteId);

      if (filtered.length !== notes.length) {
        await this.itemsRepo.updateItem(item.id, { notes: filtered as any });
        return true;
      }
    }

    throw new NotFoundException('Note not found in this workspace');
  }
}
