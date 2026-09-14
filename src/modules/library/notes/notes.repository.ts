import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { VersionMismatchException } from '../core/errors/version-mismatch.exception';
import { normalizeTags } from '../tags/utils/tags.utils';

import { CreateNoteData, UpdateNoteData } from './types/notes.types';

export { CreateNoteData, UpdateNoteData };

@Injectable()
export class NotesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findMany(
    userId: string,
    itemId?: string,
    projectIdOrTx?: string | Prisma.TransactionClient,
    tx?: Prisma.TransactionClient,
  ) {
    const projectId =
      typeof projectIdOrTx === 'string' ? projectIdOrTx : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    const where: Prisma.NoteWhereInput =
      projectId && projectId !== 'user'
        ? {
            projectId,
            ...(itemId !== undefined ? { itemId } : {}),
            deletedAt: null,
          }
        : {
            userId,
            ...(itemId !== undefined ? { itemId } : {}),
            deletedAt: null,
          };

    return client.note.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findById(
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user' ? { projectId } : { userId };
    return client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });
  }

  async create(
    userId: string,
    data: CreateNoteData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.note.create({
      data: {
        userId,
        projectId: data.projectId ?? null,
        itemId: data.itemId ?? null,
        title: data.title ?? 'Untitled Note',
        contentJson:
          data.contentJson !== undefined && data.contentJson !== null
            ? (data.contentJson as Prisma.InputJsonValue)
            : Prisma.DbNull,
        contentMd: data.contentMd ?? '',
        tags: data.tags ? normalizeTags(data.tags) : [],
        createdById: data.createdById || userId,
        version: 1,
      },
    });
  }

  async update(
    userId: string,
    id: string,
    expectedVersion: number,
    data: UpdateNoteData,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user' ? { projectId } : { userId };
    const existing = await client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    if (existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Note',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    return client.note.update({
      where: { id },
      data: {
        title: data.title ?? existing.title,
        contentJson:
          data.contentJson !== undefined
            ? data.contentJson !== null
              ? (data.contentJson as Prisma.InputJsonValue)
              : Prisma.DbNull
            : undefined,
        contentMd:
          data.contentMd !== undefined ? data.contentMd : existing.contentMd,
        tags:
          data.tags !== undefined ? normalizeTags(data.tags) : existing.tags,
        version: { increment: 1 },
      },
    });
  }

  async softDelete(
    userId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const scopeWhere =
      projectId && projectId !== 'user' ? { projectId } : { userId };
    if (expectedVersion !== undefined) {
      const existing = await client.note.findFirst({
        where: { id, ...scopeWhere, deletedAt: null },
      });
      if (existing && existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'Note',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
    }

    const result = await client.note.updateMany({
      where: { id, ...scopeWhere, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }
}
