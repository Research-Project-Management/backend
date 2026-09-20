import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { VersionMismatchException } from '../../../shared-kernel/core/errors/version-mismatch.exception';
import { normalizeTags } from '../../../shared-kernel/utils/tag.utils';

import { CreateNoteData, UpdateNoteData } from '../../domain/types/notes.types';

export { CreateNoteData, UpdateNoteData };

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

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
      typeof projectIdOrTx === 'string' &&
      projectIdOrTx !== 'user' &&
      projectIdOrTx !== 'me' &&
      projectIdOrTx !== 'personal' &&
      isUuid(projectIdOrTx)
        ? projectIdOrTx
        : undefined;
    const client = this.getClient(
      typeof projectIdOrTx === 'object' ? projectIdOrTx : tx,
    );
    const where: Prisma.NoteWhereInput = projectId
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
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal' &&
      isUuid(projectId)
        ? { projectId }
        : { userId };
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

  async reassignToItem(
    sourceItemIds: string[],
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const client = this.getClient(tx);
    await client.note.updateMany({
      where: { itemId: { in: sourceItemIds } },
      data: { itemId: targetItemId },
    });
  }

  async createLiteratureNote(
    userId: string,
    itemId: string,
    content: string,
    source?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    const client = this.getClient(tx);
    const existing = await client.note.findFirst({
      where: {
        userId,
        itemId,
        contentMd: trimmed,
        deletedAt: null,
      },
    });
    if (existing) return;

    await client.note.create({
      data: {
        userId,
        itemId,
        title: source ? `Imported Note (${source})` : 'Imported Note',
        contentMd: trimmed,
        contentJson: {
          type: 'doc',
          content: [{ type: 'paragraph', text: trimmed }],
        },
        createdById: userId || 'system',
        tags: ['imported', ...(source ? [source] : [])],
        version: 1,
      },
    });
  }

  async findItemAnnotations(itemId: string): Promise<any[]> {
    const attachments = await this.prisma.attachment.findMany({
      where: { itemId },
      select: { id: true },
    });
    const attachmentIds = attachments.map((a) => a.id);
    if (attachmentIds.length === 0) return [];
    return this.prisma.annotation.findMany({
      where: { attachmentId: { in: attachmentIds }, deletedAt: null },
      orderBy: [{ pageIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }
}
