import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { VersionMismatchException } from '../common/library-mutation.dto';

export interface CreateNoteData {
  itemId?: string | null;
  title?: string;
  contentJson?: any;
  contentMd?: string;
  tags?: string[];
  createdById: string;
}

export interface UpdateNoteData {
  title?: string;
  contentJson?: any;
  contentMd?: string;
  tags?: string[];
}

@Injectable()
export class NotesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findMany(
    workspaceId: string,
    itemId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.note.findMany({
      where: {
        workspaceId,
        ...(itemId !== undefined ? { itemId } : {}),
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.note.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
  }

  async create(
    workspaceId: string,
    data: CreateNoteData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.note.create({
      data: {
        workspaceId,
        itemId: data.itemId ?? null,
        title: data.title ?? 'Untitled Note',
        contentJson: data.contentJson ?? null,
        contentMd: data.contentMd ?? '',
        tags: data.tags ?? [],
        createdById: data.createdById,
        version: 1,
      },
    });
  }

  async update(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    data: UpdateNoteData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const existing = await client.note.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(
        `Note ${id} not found in workspace ${workspaceId}`,
      );
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
            ? data.contentJson
            : existing.contentJson,
        contentMd:
          data.contentMd !== undefined ? data.contentMd : existing.contentMd,
        tags: data.tags ?? existing.tags,
        version: { increment: 1 },
      },
    });
  }

  async softDelete(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    if (expectedVersion !== undefined) {
      const existing = await client.note.findFirst({
        where: { id, workspaceId, deletedAt: null },
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
      where: { id, workspaceId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }
}
