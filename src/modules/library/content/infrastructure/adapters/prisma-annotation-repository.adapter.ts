import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import {
  IAnnotationRepositoryPort,
  FindAnnotationsOptions,
} from '../../domain/ports/annotation-repository.port';
import {
  AnnotationEntity,
  AnnotationType,
  AnnotationPosition,
} from '../../domain/model/annotation.entity';

/**
 * Infrastructure Adapter — implements IAnnotationRepositoryPort using Prisma.
 *
 * Note: The Prisma Annotation model uses:
 * - `authorId` (not `userId`) for ownership
 * - `attachmentId` as a relation scalar (connects via Attachment)
 * - `annotationSortIndex` (not `sortIndex`)
 * - `quoteText` (not `text`)
 * - `rectCoords` (not `position`)
 *
 * Outbound / Driven adapter. Application Use Cases inject this via the Port symbol.
 */
@Injectable()
export class PrismaAnnotationRepositoryAdapter implements IAnnotationRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): AnnotationEntity {
    return AnnotationEntity.reconstitute({
      id: raw.id,
      attachmentId: raw.attachmentId,
      itemId: raw.attachmentId, // Annotation is scoped to attachment, itemId derived if needed
      userId: raw.authorId,
      type: (raw.type ?? 'highlight') as AnnotationType,
      color: raw.color ?? '#ffeb3b',
      text: raw.quoteText,
      comment: raw.comment,
      position: raw.rectCoords as AnnotationPosition | null,
      pageIndex: raw.pageIndex ?? undefined,
      sortIndex: raw.annotationSortIndex,
      isAuthoritative: false,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  async findById(annotationId: string): Promise<AnnotationEntity | null> {
    const raw = await this.prisma.annotation.findUnique({
      where: { id: annotationId },
    });
    return raw ? this.toEntity(raw) : null;
  }

  async findMany(
    userId: string,
    options: FindAnnotationsOptions,
  ): Promise<AnnotationEntity[]> {
    const where: any = { authorId: userId, deletedAt: null };
    if (options.attachmentId) where.attachmentId = options.attachmentId;
    if (options.type) where.type = options.type;

    const rows = await this.prisma.annotation.findMany({
      where,
      orderBy: [{ pageIndex: 'asc' }],
    });
    return rows.map((r) => this.toEntity(r));
  }

  async save(entity: AnnotationEntity): Promise<void> {
    await this.prisma.annotation.upsert({
      where: { id: entity.id },
      create: {
        id: entity.id,
        attachmentId: entity.attachmentId,
        authorId: entity.userId,
        type: entity.type as any,
        color: entity.color,
        quoteText: entity.text ?? undefined,
        comment: entity.comment ?? undefined,
        rectCoords: (entity.position ?? undefined) as any,
        pageIndex: entity.pageIndex ?? 0,
        annotationSortIndex: entity.sortIndex ?? '',
      },
      update: {
        color: entity.color,
        comment: entity.comment ?? undefined,
        updatedAt: entity.updatedAt,
      },
    });
  }

  async delete(annotationId: string, _userId: string): Promise<boolean> {
    const result = await this.prisma.annotation.updateMany({
      where: { id: annotationId },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }

  async deleteByAttachment(attachmentId: string): Promise<number> {
    const result = await this.prisma.annotation.deleteMany({
      where: { attachmentId },
    });
    return result.count;
  }
}
