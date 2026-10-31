import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { Prisma, AnnotationType } from '@prisma/client';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import {
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  UpsertAnnotationItem,
  BatchAnnotationsResult,
} from '@/modules/library/extraction/types/annotations.types';
import { buildAnnotationSortIndex } from '@/modules/library/core';

export type { AnnotationEntity, CreateAnnotationData, UpdateAnnotationData };

const ANNOTATION_SELECT = {
  id: true,
  attachmentId: true,
  type: true,
  pageIndex: true,
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

  private normalizeRectItem(item: unknown): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    height: number;
  } | null {
    if (Array.isArray(item) && item.length === 4 && item.every((n) => typeof n === 'number')) {
      const [x1, y1, x2, y2] = item as [number, number, number, number];
      return {
        x1,
        y1,
        x2,
        y2,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
      };
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const r = item as Record<string, unknown>;
      const x1 = typeof r.x1 === 'number' ? r.x1 : typeof r.x === 'number' ? r.x : undefined;
      const y1 = typeof r.y1 === 'number' ? r.y1 : typeof r.y === 'number' ? r.y : undefined;
      const w = typeof r.width === 'number' ? r.width : undefined;
      const h = typeof r.height === 'number' ? r.height : undefined;
      const x2 = typeof r.x2 === 'number' ? r.x2 : x1 !== undefined && w !== undefined ? x1 + w : undefined;
      const y2 = typeof r.y2 === 'number' ? r.y2 : y1 !== undefined && h !== undefined ? y1 + h : undefined;
      if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
        return {
          x1,
          y1,
          x2,
          y2,
          width: w ?? Math.max(0, x2 - x1),
          height: h ?? Math.max(0, y2 - y1),
        };
      }
    }
    return null;
  }

  private mapEntity(raw: AnnotationEntity): AnnotationEntity {
    const rects: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      height: number;
    }> = [];
    const rc = raw.rectCoords;
    if (Array.isArray(rc)) {
      if (rc.length === 4 && rc.every((n) => typeof n === 'number')) {
        const single = this.normalizeRectItem(rc);
        if (single) rects.push(single);
      } else {
        for (const entry of rc) {
          const mapped = this.normalizeRectItem(entry);
          if (mapped) rects.push(mapped);
        }
      }
    } else if (rc && typeof rc === 'object') {
      const single = this.normalizeRectItem(rc);
      if (single) rects.push(single);
    }

    return {
      ...raw,
      text: raw.quoteText ?? '',
      rects,
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
    if (!Array.isArray(rectCoords) || rectCoords.length === 0) {
      return null;
    }
    if (
      rectCoords.length === 4 &&
      rectCoords.every((c) => typeof c === 'number' && Number.isFinite(c))
    ) {
      const [x1, y1, x2, y2] = rectCoords as number[];
      return {
        y: Math.min(y1, y2),
        x: Math.min(x1, x2),
      };
    }
    const first = rectCoords[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const r = first as Record<string, unknown>;
      const rawX = Number(r.x1 ?? r.x);
      const rawY = Number(r.y1 ?? r.y);
      if (Number.isFinite(rawX) && Number.isFinite(rawY)) {
        return { y: rawY, x: rawX };
      }
    }
    return null;
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
      : current.rectCoords != null
        ? (current.rectCoords as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    let annotationSortIndex =
      data.annotationSortIndex ?? current.annotationSortIndex ?? '';
    if (
      data.annotationSortIndex === undefined &&
      (coordsUpdated || data.y !== undefined || data.x !== undefined)
    ) {
      const topLeft = this.deriveTopLeftFromRectCoords(
        coordsUpdated ? data.rectCoords : current.rectCoords,
        data.y,
        data.x,
      );
      if (topLeft) {
        annotationSortIndex = buildAnnotationSortIndex(
          current.pageIndex,
          topLeft.y,
          topLeft.x,
        );
      }
    }

    return {
      color: data.color ?? current.color,
      quoteText:
        data.quoteText !== undefined ? data.quoteText : current.quoteText,
      comment: data.comment !== undefined ? data.comment : current.comment,
      tags: data.tags !== undefined ? data.tags : current.tags,
      rectCoords: nextRectCoords,
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
        type: data.type ?? AnnotationType.highlight,
        pageIndex: data.pageIndex,
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
      const reloaded = await this.findById(id, tx);
      if (!reloaded) {
        throw new NotFoundException(`Annotation ${id} not found`);
      }
      return reloaded;
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
        where: { id: { in: idsToLookup }, attachmentId },
        select: ANNOTATION_SELECT,
      });
      for (const row of existingRows) {
        existingMap.set(row.id, row);
      }
    }

    for (const item of upserts) {
      const current = item.id ? existingMap.get(item.id) : undefined;
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

        const updatePayload = {
          ...this.buildUpdateData(
            {
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
          ...(isResurrecting ? { deletedAt: null } : {}),
        };

        if (
          !isResurrecting &&
          item.expectedVersion !== undefined &&
          tx.annotation?.updateMany
        ) {
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
            const fresh = await this.findById(current.id, tx);
            throw new VersionMismatchException({
              aggregateType: 'Annotation',
              entityId: current.id,
              currentVersion: fresh?.version ?? current.version,
              providedVersion: item.expectedVersion,
            });
          }
          const reloaded = await this.findById(current.id, tx);
          if (!reloaded) {
            throw new NotFoundException(`Annotation ${current.id} not found`);
          }
          updated.push(reloaded);
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
        const topLeft = this.deriveTopLeftFromRectCoords(
          item.rectCoords,
          item.y,
          item.x,
        );
        const result = await tx.annotation.create({
          data: {
            ...(item.id ? { id: item.id } : {}),
            attachmentId,
            type: item.type ?? AnnotationType.highlight,
            pageIndex: item.pageIndex,
            annotationSortIndex: buildAnnotationSortIndex(
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

    if (deletes.length > 0) {
      const candidates = await tx.annotation.findMany({
        where: {
          id: { in: deletes },
          attachmentId,
          authorId,
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
}
