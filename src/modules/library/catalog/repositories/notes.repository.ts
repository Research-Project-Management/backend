import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, Annotation } from '@prisma/client';
import { isUUID } from 'class-validator';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { buildTipTapDocFromText } from '@/modules/library/core/domain/tiptap.domain';
import {
  CreateNoteData,
  UpdateNoteData,
} from '@/modules/library/catalog/types/notes.types';

export type { CreateNoteData, UpdateNoteData };

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
          projectId: null,
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
        : { userId, projectId: null };
    return client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });
  }

  async syncItemNoteCount(
    itemId: string | null | undefined,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!itemId || !isUuid(itemId)) return;
    const client = this.getClient(tx);
    if (
      typeof client.note?.count !== 'function' ||
      typeof client.item?.updateMany !== 'function'
    ) {
      return;
    }
    const activeCount = await client.note.count({
      where: { itemId, deletedAt: null },
    });
    await client.item.updateMany({
      where: { id: itemId },
      data: { noteCount: activeCount },
    });
  }

  async create(
    userId: string,
    data: CreateNoteData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const contentMd = data.contentMd ?? '';
    const created = await client.note.create({
      data: {
        userId,
        projectId: data.projectId ?? null,
        itemId: data.itemId ?? null,
        title: data.title ?? 'Untitled Note',
        contentJson:
          data.contentJson !== undefined && data.contentJson !== null
            ? (data.contentJson as Prisma.InputJsonValue)
            : (buildTipTapDocFromText(contentMd) as Prisma.InputJsonValue),
        contentMd,
        tags: data.tags ? normalizeTags(data.tags) : [],
        createdById: data.createdById || userId,
        version: 1,
      },
    });
    await this.syncItemNoteCount(created.itemId ?? data.itemId, tx);
    return created;
  }

  async update(
    userId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateNoteData,
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
        : { userId, projectId: null };
    const existing = await client.note.findFirst({
      where: { id, ...scopeWhere, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    const effectiveExpectedVersion = expectedVersion ?? data?.expectedVersion;

    if (
      effectiveExpectedVersion !== undefined &&
      existing.version !== effectiveExpectedVersion
    ) {
      throw new VersionMismatchException({
        aggregateType: 'Note',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: effectiveExpectedVersion,
      });
    }

    if (
      effectiveExpectedVersion !== undefined &&
      typeof client.note.updateMany === 'function'
    ) {
      const affected = await client.note.updateMany({
        where: {
          id,
          ...scopeWhere,
          deletedAt: null,
          version: effectiveExpectedVersion,
        },
        data: {
          version: { increment: 1 },
        },
      });

      if (affected.count === 0) {
        const fresh =
          typeof client.note.findUnique === 'function'
            ? await client.note.findUnique({
                where: { id },
                select: { version: true },
              })
            : null;
        throw new VersionMismatchException({
          aggregateType: 'Note',
          entityId: id,
          currentVersion: fresh?.version ?? existing.version,
          providedVersion: effectiveExpectedVersion,
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
              : data.contentMd !== undefined
                ? (buildTipTapDocFromText(
                    data.contentMd,
                  ) as Prisma.InputJsonValue)
                : undefined,
          contentMd:
            data.contentMd !== undefined ? data.contentMd : existing.contentMd,
          tags:
            data.tags !== undefined ? normalizeTags(data.tags) : existing.tags,
        },
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
            : data.contentMd !== undefined
              ? (buildTipTapDocFromText(
                  data.contentMd,
                ) as Prisma.InputJsonValue)
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
      projectId &&
      projectId !== 'user' &&
      projectId !== 'me' &&
      projectId !== 'personal' &&
      isUuid(projectId)
        ? { projectId }
        : { userId, projectId: null };
    const existing =
      typeof client.note?.findFirst === 'function'
        ? await client.note.findFirst({
            where: { id, ...scopeWhere, deletedAt: null },
          })
        : null;
    if (expectedVersion !== undefined) {
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

    if (result.count > 0 && existing?.itemId) {
      await this.syncItemNoteCount(existing.itemId, tx);
    }

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
    for (const sourceId of sourceItemIds) {
      await this.syncItemNoteCount(sourceId, tx);
    }
    await this.syncItemNoteCount(targetItemId, tx);
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
        contentJson: buildTipTapDocFromText(trimmed) as Prisma.InputJsonValue,
        createdById: userId,
        tags: normalizeTags(['imported', ...(source ? [source] : [])]),
        version: 1,
      },
    });
    await this.syncItemNoteCount(itemId, tx);
  }

  async findItemAnnotations(itemId: string): Promise<Annotation[]> {
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
