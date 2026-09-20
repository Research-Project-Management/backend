import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import {
  INoteRepositoryPort,
  FindNotesOptions,
} from '../../domain/ports/note-repository.port';
import { NoteEntity } from '../../domain/model/note.entity';

/**
 * Infrastructure Adapter — implements INoteRepositoryPort using Prisma.
 *
 * Note: The Prisma Note model uses `contentMd` (not `content`) for markdown text,
 * and `contentJson` for rich JSON content.
 *
 * Outbound / Driven adapter. Application Use Cases inject this via the Port symbol.
 */
@Injectable()
export class PrismaNoteRepositoryAdapter implements INoteRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): NoteEntity {
    return NoteEntity.reconstitute({
      id: raw.id,
      itemId: raw.itemId ?? '',
      userId: raw.userId,
      title: raw.title,
      content: raw.contentMd, // map contentMd → content in domain
      contentHtml: undefined, // contentJson is JSON, not HTML
      parentId: null,
      version: raw.version ?? 1,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      deletedAt: raw.deletedAt,
    });
  }

  async findById(noteId: string, userId: string): Promise<NoteEntity | null> {
    const raw = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
    });
    return raw ? this.toEntity(raw) : null;
  }

  async findMany(
    userId: string,
    options: FindNotesOptions,
  ): Promise<NoteEntity[]> {
    const where: any = {
      userId,
      ...(options.includeDeleted ? {} : { deletedAt: null }),
    };
    if (options.itemId) where.itemId = options.itemId;

    const rows = await this.prisma.note.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.toEntity(r));
  }

  async save(entity: NoteEntity): Promise<void> {
    await this.prisma.note.upsert({
      where: { id: entity.id },
      create: {
        id: entity.id,
        itemId: entity.itemId || undefined,
        userId: entity.userId,
        title: entity.title ?? 'Untitled Note',
        contentMd: entity.content ?? '',
        version: entity.version,
      },
      update: {
        title: entity.title ?? undefined,
        contentMd: entity.content ?? undefined,
        version: entity.version,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
      },
    });
  }

  async delete(noteId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.note.updateMany({
      where: { id: noteId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }
}
