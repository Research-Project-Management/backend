import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { Prisma, AnnotationType } from '@prisma/client';
import { VersionMismatchException } from '../../../shared-kernel/core/errors/version-mismatch.exception';
import {
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  UpsertAnnotationItem,
  BatchAnnotationsResult,
} from '../../domain/types/annotations.types';
import { buildAnnotationSortIndex } from '../../application/utils/sort-index.util';

export { AnnotationEntity, CreateAnnotationData, UpdateAnnotationData };

// ─── Select shape ─────────────────────────────────────────────────────────────

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

  // ─── Queries ───────────────────────────────────────────────────────────────

  async findByAttachment(
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    tx?: Prisma.TransactionClient,
  ): Promise<AnnotationEntity[]> {
    const client = this.getClient(tx);
    return client.annotation.findMany({
      where: {
        attachmentId,
        deletedAt: null,
        ...(pageIndex !== undefined && { pageIndex }),
        ...(type !== undefined && { type }),
      },
      select: ANNOTATION_SELECT,
      orderBy: [
        // Primary: Zotero-compatible sort index (page → Y → X)
        { annotationSortIndex: 'asc' },
        // Fallback for annotations without sortIndex
        { pageIndex: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AnnotationEntity | null> {
    const client = this.getClient(tx);
    return client.annotation.findFirst({
      where: { id, deletedAt: null },
      select: ANNOTATION_SELECT,
    });
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

  // ─── Mutations ─────────────────────────────────────────────────────────────

  async create(
    data: CreateAnnotationData,
    tx?: Prisma.TransactionClient,
  ): Promise<AnnotationEntity> {
    const client = this.getClient(tx);
    return client.annotation.create({
      data: {
        attachmentId: data.attachmentId,
        type: data.type ?? AnnotationType.highlight,
        pageIndex: data.pageIndex,
        annotationSortIndex: buildAnnotationSortIndex(
          data.pageIndex,
          data.y,
          data.x,
        ),
        color: data.color ?? '#ffeb3b',
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

    return client.annotation.update({
      where: { id },
      data: {
        color: data.color ?? current.color,
        quoteText:
          data.quoteText !== undefined ? data.quoteText : current.quoteText,
        comment: data.comment !== undefined ? data.comment : current.comment,
        tags: data.tags !== undefined ? data.tags : current.tags,
        rectCoords:
          data.rectCoords !== undefined
            ? data.rectCoords != null
              ? (data.rectCoords as Prisma.InputJsonValue)
              : Prisma.JsonNull
            : current.rectCoords != null
              ? (current.rectCoords as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        version: { increment: 1 },
      },
      select: ANNOTATION_SELECT,
    });
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
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }

  // ─── Batch ─────────────────────────────────────────────────────────────────

  async batchUpsert(
    attachmentId: string,
    authorId: string,
    upserts: UpsertAnnotationItem[],
    deletes: string[],
    tx: Prisma.TransactionClient,
  ): Promise<BatchAnnotationsResult> {
    const created: AnnotationEntity[] = [];
    const updated: AnnotationEntity[] = [];
    const deleted: string[] = [];

    // ── Upserts ────────────────────────────────────────────────────────────
    for (const item of upserts) {
      if (item.id) {
        // Update path
        const current = await tx.annotation.findFirst({
          where: { id: item.id, deletedAt: null },
          select: ANNOTATION_SELECT,
        });
        if (!current)
          throw new NotFoundException(`Annotation ${item.id} not found`);

        if (
          item.expectedVersion !== undefined &&
          current.version !== item.expectedVersion
        ) {
          throw new VersionMismatchException({
            aggregateType: 'Annotation',
            entityId: item.id,
            currentVersion: current.version,
            providedVersion: item.expectedVersion,
          });
        }

        const result = await tx.annotation.update({
          where: { id: item.id },
          data: {
            color: item.color ?? current.color,
            quoteText:
              item.quoteText !== undefined ? item.quoteText : current.quoteText,
            comment:
              item.comment !== undefined ? item.comment : current.comment,
            tags: item.tags !== undefined ? item.tags : current.tags,
            rectCoords:
              item.rectCoords !== undefined
                ? item.rectCoords != null
                  ? (item.rectCoords as Prisma.InputJsonValue)
                  : Prisma.JsonNull
                : current.rectCoords != null
                  ? (current.rectCoords as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
            annotationSortIndex:
              item.y !== undefined || item.x !== undefined
                ? buildAnnotationSortIndex(item.pageIndex, item.y, item.x)
                : current.annotationSortIndex,
            version: { increment: 1 },
          },
          select: ANNOTATION_SELECT,
        });
        updated.push(result);
      } else {
        // Create path
        const result = await tx.annotation.create({
          data: {
            attachmentId,
            type: item.type ?? AnnotationType.highlight,
            pageIndex: item.pageIndex,
            annotationSortIndex: buildAnnotationSortIndex(
              item.pageIndex,
              item.y,
              item.x,
            ),
            color: item.color ?? '#ffeb3b',
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
        created.push(result);
      }
    }

    // ── Soft deletes ───────────────────────────────────────────────────────
    for (const id of deletes) {
      const result = await tx.annotation.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (result.count > 0) deleted.push(id);
    }

    return { created, updated, deleted };
  }
}
