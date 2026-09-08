import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma, AnnotationType } from '@prisma/client';
import { VersionMismatchException } from '../common/errors/version-mismatch.exception';

export interface CreateAnnotationData {
  attachmentId: string;
  type?: AnnotationType;
  pageIndex: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: any;
  authorId: string;
}

export interface UpdateAnnotationData {
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: any;
}

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
        rectCoords: data.rectCoords ?? null,
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
  ) {
    const client = this.getClient(tx);
    const existing = await this.findById(id, tx);
    if (!existing) {
      throw new NotFoundException(`Annotation ${id} not found`);
    }

    if (existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'Annotation',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    return client.annotation.update({
      where: { id },
      data: {
        color: data.color ?? existing.color,
        quoteText:
          data.quoteText !== undefined ? data.quoteText : existing.quoteText,
        comment: data.comment !== undefined ? data.comment : existing.comment,
        rectCoords:
          data.rectCoords !== undefined ? data.rectCoords : existing.rectCoords,
        version: { increment: 1 },
      },
    });
  }

  async softDelete(
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    if (expectedVersion !== undefined) {
      const existing = await this.findById(id, tx);
      if (existing && existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'Annotation',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
    }

    const existing = await this.findById(id, tx);
    if (!existing) {
      return false;
    }

    const result = await client.annotation.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }
}
