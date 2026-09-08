import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma, AnnotationType } from '@prisma/client';
import { VersionMismatchException } from '../common/errors/version-mismatch.exception';

import {
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
} from './types/annotations.types';

export { AnnotationEntity, CreateAnnotationData, UpdateAnnotationData };

@Injectable()
export class AnnotationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findByAttachment(
    attachmentId: string,
    pageIndex?: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.annotation.findMany({
      where: {
        attachmentId,
        ...(pageIndex !== undefined ? { pageIndex } : {}),
        deletedAt: null,
      },
      orderBy: [{ pageIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findById(id: string, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.annotation.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async create(data: CreateAnnotationData, tx?: Prisma.TransactionClient) {
    const client = this.getClient(tx);
    return client.annotation.create({
      data: {
        attachmentId: data.attachmentId,
        type: data.type ?? AnnotationType.highlight,
        pageIndex: data.pageIndex,
        color: data.color ?? '#ffeb3b',
        quoteText: data.quoteText ?? '',
        comment: data.comment ?? '',
        rectCoords:
          data.rectCoords !== undefined && data.rectCoords !== null
            ? (data.rectCoords as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        authorId: data.authorId,
        version: 1,
      },
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    tx?: Prisma.TransactionClient,
    existing?: AnnotationEntity,
  ) {
    const client = this.getClient(tx);
    const current = existing ?? (await this.findById(id, tx));
    if (!current) {
      throw new NotFoundException(`Annotation ${id} not found`);
    }

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
        rectCoords:
          data.rectCoords !== undefined
            ? ((data.rectCoords as Prisma.InputJsonValue) ?? Prisma.JsonNull)
            : current.rectCoords === null
              ? Prisma.JsonNull
              : (current.rectCoords as Prisma.InputJsonValue),
        version: { increment: 1 },
      },
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
    if (!current) {
      return false;
    }

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
}
