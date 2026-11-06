import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, AnnotationType } from '@prisma/client';
import { VersionMismatchException } from '@/modules/library/core/errors/domain.exception';
import {
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  UpsertAnnotationItem,
  BatchAnnotationsResult,
} from '@/modules/library/core/types/extraction.types';
import {
  buildAnnotationSortIndex,
  uuidv7,
  isUuid,
} from '@/modules/library/core';
import {
  extractTopLeftAnchor,
  normalizeRectCoordsToBoxes,
} from '@/modules/library/extraction/domain/annotations.domain';

export type { AnnotationEntity, CreateAnnotationData, UpdateAnnotationData };

const ANNOTATION_SELECT = {
  id: true,
  attachmentId: true,
  itemId: true,
  type: true,
  pageIndex: true,
  pageLabel: true,
  annotationSortIndex: true,
  color: true,
  quoteText: true,
  comment: true,
  tags: true,
  rectCoords: true,
  authorId: true,
  version: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AnnotationSelect;

@Injectable()
export class AnnotationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  private mapEntity(raw: AnnotationEntity): AnnotationEntity {
    return {
      ...raw,
      text: raw.quoteText ?? '',
      rects: normalizeRectCoordsToBoxes(raw.rectCoords),
    };
  }

  // Queries

  async findByAttachment(
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    tx?: Prisma.TransactionClient,
  ): Promise<AnnotationEntity[]> {
    const client = this.getClient(tx);
    const rows = await client.annotation.findMany({
      where: {
        attachmentId,
        deletedAt: null,
        ...(pageIndex !== undefined && { pageIndex }),
        ...(type !== undefined && { type }),
      },
      select: ANNOTATION_SELECT,
      orderBy: [
        { pageIndex: 'asc' },
        { annotationSortIndex: 'asc' },
        { createdAt: 'asc' },
      ],
    });
    return rows.map((r) => this.mapEntity(r));
  }

  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AnnotationEntity | null> {
    const client = this.getClient(tx);
    const row = await client.annotation.findFirst({
      where: { id, deletedAt: null },
      select: ANNOTATION_SELECT,
    });
    return row ? this.mapEntity(row) : null;
  }

  async findExistingForImport(
    attachmentId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.annotation.findMany({
      where: { attachmentId, deletedAt: null },
      select: { pageIndex: true, type: true, rectCoords: true },
    });
  }

  private deriveTopLeftFromRectCoords(
    rectCoords: unknown,
    fallbackY?: number,
    fallbackX?: number,
  ): { y: number; x: number } | null {
    if (fallbackY !== undefined || fallbackX !== undefined) {
      return { y: fallbackY ?? 0, x: fallbackX ?? 0 };
    }
    const anchor = extractTopLeftAnchor(rectCoords);
    return anchor ? { y: anchor.y1, x: anchor.x1 } : null;
  }

  private buildUpdateData(
    data: UpdateAnnotationData,
    current: AnnotationEntity,
  ) {
    const coordsUpdated = data.rectCoords !== undefined;
    const nextRectCoords = coordsUpdated
      ? data.rectCoords != null
        ? (data.rectCoords as Prisma.InputJsonValue)
        : Prisma.JsonNull
      : undefined;

    const targetPageIndex = data.pageIndex ?? current.pageIndex;

    let annotationSortIndex =
      data.annotationSortIndex ?? current.annotationSortIndex ?? '';
    if (
      data.annotationSortIndex === undefined &&
      (coordsUpdated ||
        data.y !== undefined ||
        data.x !== undefined ||
        data.pageIndex !== undefined)
    ) {
      const topLeft = this.deriveTopLeftFromRectCoords(
        coordsUpdated ? data.rectCoords : current.rectCoords,
        data.y,
        data.x,
      );
      annotationSortIndex = buildAnnotationSortIndex(
        targetPageIndex,
        topLeft?.y ?? data.y ?? 0,
        topLeft?.x ?? data.x ?? 0,
      );
    }

    return {
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.pageIndex !== undefined ? { pageIndex: data.pageIndex } : {}),
      ...(data.pageLabel !== undefined
        ? { pageLabel: data.pageLabel }
        : current.pageLabel !== undefined
          ? { pageLabel: current.pageLabel }
          : {}),
      ...(data.imageFileId !== undefined
        ? { imageFileId: data.imageFileId }
        : {}),
      color: data.color ?? current.color,
      quoteText:
        data.quoteText !== undefined ? data.quoteText : current.quoteText,
      comment: data.comment !== undefined ? data.comment : current.comment,
      tags: data.tags !== undefined ? data.tags : current.tags,
      ...(coordsUpdated && nextRectCoords !== undefined
        ? { rectCoords: nextRectCoords }
        : {}),
      annotationSortIndex,
    };
  }

  // Mutations

  async create(
    data: CreateAnnotationData,
    tx?: Prisma.TransactionClient,
  ): Promise<AnnotationEntity> {
    const client = this.getClient(tx);
    const topLeft = this.deriveTopLeftFromRectCoords(
      data.rectCoords,
      data.y,
      data.x,
    );
    const row = await client.annotation.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        attachmentId: data.attachmentId,
        ...(data.itemId ? { itemId: data.itemId } : {}),
        ...(data.imageFileId !== undefined
          ? { imageFileId: data.imageFileId }
          : {}),
        type: data.type ?? AnnotationType.highlight,
        pageIndex: data.pageIndex,
        ...(data.pageLabel !== undefined ? { pageLabel: data.pageLabel } : {}),
        annotationSortIndex:
          data.annotationSortIndex ??
          buildAnnotationSortIndex(
            data.pageIndex,
            topLeft?.y ?? data.y,
            topLeft?.x ?? data.x,
          ),
        color: data.color ?? '#ffd400',
        quoteText: data.quoteText ?? '',
        comment: data.comment ?? '',
        tags: data.tags ?? [],
        rectCoords:
          data.rectCoords != null
            ? (data.rectCoords as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        authorId: data.authorId,
        version: 1,
      },
      select: ANNOTATION_SELECT,
    });
    return this.mapEntity(row);
  }

  async update(
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    tx?: Prisma.TransactionClient,
    existing?: AnnotationEntity,
  ): Promise<AnnotationEntity> {
    const client = this.getClient(tx);
    const current = existing ?? (await this.findById(id, tx));
    if (!current) throw new NotFoundException(`Annotation ${id} not found`);

    if (current.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Annotation',
        entityId: id,
        currentVersion: current.version,
        providedVersion: expectedVersion,
      });
    }

    const updatePayload = this.buildUpdateData(data, current);

    if (client.annotation?.updateMany) {
      const now = new Date();
      const affected = await client.annotation.updateMany({
        where: { id, deletedAt: null, version: expectedVersion },
        data: {
          ...updatePayload,
          version: { increment: 1 },
        },
      });
      if (affected.count === 0) {
        const fresh = await this.findById(id, tx);
        throw new VersionMismatchException({
          aggregateType: 'Annotation',
          entityId: id,
          currentVersion: fresh?.version ?? current.version,
          providedVersion: expectedVersion,
        });
      }
      const nextRects =
        data.rectCoords !== undefined ? data.rectCoords : current.rectCoords;
      return this.mapEntity({
        ...current,
        ...updatePayload,
        rectCoords: (nextRects ?? null) as Prisma.JsonValue,
        version: current.version + 1,
        updatedAt: now,
      });
    }

    const row = await client.annotation.update({
      where: { id },
      data: {
        ...updatePayload,
        version: { increment: 1 },
      },
      select: ANNOTATION_SELECT,
    });
    return this.mapEntity(row);
  }

  async softDelete(
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    existing?: AnnotationEntity,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const current = existing ?? (await this.findById(id, tx));
    if (!current) return false;

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Annotation',
        entityId: id,
        currentVersion: current.version,
        providedVersion: expectedVersion,
      });
    }

    const result = await client.annotation.updateMany({
      where: {
        id,
        deletedAt: null,
        ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
      },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count === 0 && expectedVersion !== undefined) {
      const fresh = await this.findById(id, tx);
      if (fresh) {
        throw new VersionMismatchException({
          aggregateType: 'Annotation',
          entityId: id,
          currentVersion: fresh.version,
          providedVersion: expectedVersion,
        });
      }
    }

    return result.count > 0;
  }

  // Batch

  async batchUpsert(
    attachmentId: string,
    authorId: string,
    upserts: UpsertAnnotationItem[],
    deletes: string[],
    tx: Prisma.TransactionClient,
    itemId?: string,
    allowAdminDelete?: boolean,
  ): Promise<BatchAnnotationsResult> {
    const created: AnnotationEntity[] = [];
    const updated: AnnotationEntity[] = [];
    let deleted: string[] = [];

    const idsToLookup = upserts
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));

    const existingMap = new Map<string, AnnotationEntity>();
    if (idsToLookup.length > 0) {
      const existingRows = await tx.annotation.findMany({
        where: { id: { in: idsToLookup } },
        select: ANNOTATION_SELECT,
      });
      for (const row of existingRows) {
        existingMap.set(row.id, row);
      }
    }

    const newItemsToCreate: UpsertAnnotationItem[] = [];

    for (const item of upserts) {
      const current = item.id ? existingMap.get(item.id) : undefined;
      if (current && current.attachmentId !== attachmentId) {
        throw new NotFoundException(
          `Annotation ${item.id} does not belong to attachment ${attachmentId}`,
        );
      }
      if (item.id && !current && item.expectedVersion !== undefined) {
        throw new NotFoundException(`Annotation ${item.id} not found`);
      }

      if (current) {
        if (current.authorId !== authorId) {
          throw new ForbiddenException(
            'You can only modify your own annotations',
          );
        }

        const isResurrecting = current.deletedAt !== null;

        if (
          !isResurrecting &&
          item.expectedVersion !== undefined &&
          current.version !== item.expectedVersion
        ) {
          throw new VersionMismatchException({
            aggregateType: 'Annotation',
            entityId: current.id,
            currentVersion: current.version,
            providedVersion: item.expectedVersion,
          });
        }

        const resolvedCurrentItemId = current.itemId || item.itemId || itemId;
        const updatePayload = {
          ...this.buildUpdateData(
            {
              type: item.type,
              pageIndex: item.pageIndex,
              pageLabel: item.pageLabel,
              annotationSortIndex: item.annotationSortIndex,
              color: item.color,
              quoteText: item.quoteText,
              comment: item.comment,
              tags: item.tags,
              rectCoords: item.rectCoords,
              y: item.y,
              x: item.x,
            },
            current,
          ),
          ...(!current.itemId && resolvedCurrentItemId
            ? { itemId: resolvedCurrentItemId }
            : {}),
          ...(isResurrecting ? { deletedAt: null } : {}),
        };

        if (
          !isResurrecting &&
          item.expectedVersion !== undefined &&
          tx.annotation?.updateMany
        ) {
          const now = new Date();
          const affected = await tx.annotation.updateMany({
            where: {
              id: current.id,
              attachmentId,
              deletedAt: null,
              version: item.expectedVersion,
            },
            data: {
              ...updatePayload,
              version: { increment: 1 },
            },
          });
          if (affected.count === 0) {
            throw new VersionMismatchException({
              aggregateType: 'Annotation',
              entityId: current.id,
              currentVersion: current.version,
              providedVersion: item.expectedVersion,
            });
          }
          const nextRects =
            item.rectCoords !== undefined
              ? item.rectCoords
              : current.rectCoords;
          updated.push(
            this.mapEntity({
              ...current,
              ...updatePayload,
              rectCoords: (nextRects ?? null) as Prisma.JsonValue,
              version: current.version + 1,
              updatedAt: now,
            }),
          );
        } else {
          const result = await tx.annotation.update({
            where: { id: current.id },
            data: {
              ...updatePayload,
              version: { increment: 1 },
            },
            select: ANNOTATION_SELECT,
          });
          if (isResurrecting) {
            created.push(this.mapEntity(result));
          } else {
            updated.push(this.mapEntity(result));
          }
        }
      } else {
        newItemsToCreate.push(item);
      }
    }

    if (newItemsToCreate.length > 0) {
      if (tx.annotation?.createMany && newItemsToCreate.length > 1) {
        const now = new Date();
        const createPayloads: Prisma.AnnotationCreateManyInput[] = [];
        const createdEntities: AnnotationEntity[] = [];

        for (const item of newItemsToCreate) {
          const id = item.id || uuidv7();
          const topLeft = this.deriveTopLeftFromRectCoords(
            item.rectCoords,
            item.y,
            item.x,
          );
          const type = item.type ?? AnnotationType.highlight;
          const pageLabel = item.pageLabel ?? '';
          const annotationSortIndex =
            item.annotationSortIndex ??
            buildAnnotationSortIndex(
              item.pageIndex,
              topLeft?.y ?? item.y,
              topLeft?.x ?? item.x,
            );
          const color = item.color ?? '#ffd400';
          const quoteText = item.quoteText ?? '';
          const comment = item.comment ?? '';
          const tags = item.tags ?? [];

          const resolvedItemId = item.itemId || itemId;
          createPayloads.push({
            id,
            attachmentId,
            ...(resolvedItemId ? { itemId: resolvedItemId } : {}),
            ...(item.imageFileId !== undefined
              ? { imageFileId: item.imageFileId }
              : {}),
            type,
            pageIndex: item.pageIndex,
            pageLabel,
            annotationSortIndex,
            color,
            quoteText,
            comment,
            tags,
            rectCoords:
              item.rectCoords != null
                ? (item.rectCoords as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            authorId,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });

          createdEntities.push(
            this.mapEntity({
              id,
              attachmentId,
              itemId: resolvedItemId ?? null,
              type,
              pageIndex: item.pageIndex,
              pageLabel,
              annotationSortIndex,
              color,
              quoteText,
              comment,
              tags,
              rectCoords: (item.rectCoords ?? null) as Prisma.JsonValue,
              authorId,
              version: 1,
              deletedAt: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
        }

        await tx.annotation.createMany({
          data: createPayloads,
          skipDuplicates: true,
        });
        created.push(...createdEntities);
      } else {
        for (const item of newItemsToCreate) {
          const topLeft = this.deriveTopLeftFromRectCoords(
            item.rectCoords,
            item.y,
            item.x,
          );
          const resolvedItemId = item.itemId || itemId;
          const result = await tx.annotation.create({
            data: {
              ...(item.id ? { id: item.id } : {}),
              attachmentId,
              ...(resolvedItemId ? { itemId: resolvedItemId } : {}),
              ...(item.imageFileId !== undefined
                ? { imageFileId: item.imageFileId }
                : {}),
              type: item.type ?? AnnotationType.highlight,
              pageIndex: item.pageIndex,
              ...(item.pageLabel !== undefined
                ? { pageLabel: item.pageLabel }
                : {}),
              annotationSortIndex:
                item.annotationSortIndex ??
                buildAnnotationSortIndex(
                  item.pageIndex,
                  topLeft?.y ?? item.y,
                  topLeft?.x ?? item.x,
                ),
              color: item.color ?? '#ffd400',
              quoteText: item.quoteText ?? '',
              comment: item.comment ?? '',
              tags: item.tags ?? [],
              rectCoords:
                item.rectCoords != null
                  ? (item.rectCoords as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
              authorId,
              version: 1,
            },
            select: ANNOTATION_SELECT,
          });
          created.push(this.mapEntity(result));
        }
      }
    }

    if (deletes.length > 0) {
      const candidates = await tx.annotation.findMany({
        where: {
          id: { in: deletes },
          attachmentId,
          ...(allowAdminDelete ? {} : { authorId }),
          deletedAt: null,
        },
        select: { id: true },
      });
      const foundIds = candidates.map((c) => c.id);
      if (foundIds.length > 0) {
        await tx.annotation.updateMany({
          where: { id: { in: foundIds } },
          data: {
            deletedAt: new Date(),
            version: { increment: 1 },
          },
        });
      }
      deleted = foundIds;
    }

    return { created, updated, deleted };
  }

  async deleteManyByItemId(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const result = await client.annotation.deleteMany({
      where: { attachment: { itemId } },
    });
    return result.count;
  }

  async softDeleteByAttachmentIds(
    attachmentIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!attachmentIds || attachmentIds.length === 0) return 0;
    const client = this.getClient(tx);
    const result = await client.annotation.updateMany({
      where: {
        attachmentId: { in: attachmentIds },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    return result.count;
  }

  async restoreByAttachmentIds(
    attachmentIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!attachmentIds || attachmentIds.length === 0) return 0;
    const client = this.getClient(tx);
    const result = await client.annotation.updateMany({
      where: {
        attachmentId: { in: attachmentIds },
        deletedAt: { not: null },
      },
      data: { deletedAt: null },
    });
    return result.count;
  }

  async isProjectAdmin(
    userId: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!isUuid(userId) || !isUuid(projectId)) return false;
    const client = this.getClient(tx);
    try {
      const [member, project] = await Promise.all([
        client.projectMember.findFirst({
          where: { projectId, userId, project: { deletedAt: null } },
          select: { role: true },
        }),
        client.project.findFirst({
          where: { id: projectId, deletedAt: null },
          select: { createdById: true },
        }),
      ]);
      if (
        member?.role &&
        ['owner', 'coordinator'].includes(String(member.role).toLowerCase())
      ) {
        return true;
      }
      return project?.createdById === userId;
    } catch {
      return false;
    }
  }
}
