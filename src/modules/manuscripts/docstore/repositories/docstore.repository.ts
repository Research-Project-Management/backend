/**
 * modules/manuscripts/docstore/repositories/docstore.repository.ts
 * Direct PostgreSQL repository via Prisma with Optimistic Concurrency Control (OCC).
 * Eliminates unnecessary single-adapter Symbol port indirection while preserving
 * backward-compatible types and aliases.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ManuscriptDoc } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  TextDoc,
  DocModifiedError,
  DocNotFoundError,
  DocRanges,
  DocstoreMetrics,
  CreateDocData,
  UpdateDocData,
  PatchDocData,
} from '../domain';

export type { CreateDocData, UpdateDocData, PatchDocData };

@Injectable()
export class DocstoreRepository {
  private readonly logger = new Logger(DocstoreRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private mapToEntity(record: ManuscriptDoc): TextDoc {
    const rawLines = Array.isArray(record.lines)
      ? (record.lines as string[])
      : typeof record.lines === 'string'
        ? record.lines.split('\n')
        : [];

    return new TextDoc({
      id: record.id,
      projectId: record.projectId,
      path: record.path,
      lines: rawLines,
      rev: record.rev,
      version: record.version,
      ranges: (record.ranges as DocRanges) || { changes: [], comments: [] },
      hash: record.hash || '',
      sizeBytes: record.sizeBytes,
      inStorage: record.inStorage,
      storageKey: record.storageKey,
      deleted: record.deleted,
      deletedAt: record.deletedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public async getDoc(
    projectId: string,
    docId: string,
  ): Promise<TextDoc | null> {
    if (!isUuid(projectId) || !isUuid(docId)) {
      return null;
    }

    const record = await this.prisma.manuscriptDoc.findFirst({
      where: {
        id: docId,
        projectId,
      },
    });

    DocstoreMetrics.recordRead();
    if (!record) return null;
    return this.mapToEntity(record);
  }

  public async getDocById(docId: string): Promise<TextDoc | null> {
    if (!isUuid(docId)) {
      return null;
    }

    const record = await this.prisma.manuscriptDoc.findUnique({
      where: { id: docId },
    });

    DocstoreMetrics.recordRead();
    if (!record) return null;
    return this.mapToEntity(record);
  }

  public async getDocByPath(
    projectId: string,
    path: string,
  ): Promise<TextDoc | null> {
    const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const record = await this.prisma.manuscriptDoc.findFirst({
      where: {
        projectId,
        path: cleanPath,
        deleted: false,
      },
    });

    DocstoreMetrics.recordRead();
    if (!record) return null;
    return this.mapToEntity(record);
  }

  public async getAllDocs(projectId: string): Promise<TextDoc[]> {
    const records = await this.prisma.manuscriptDoc.findMany({
      where: {
        projectId,
        deleted: false,
      },
      orderBy: {
        path: 'asc',
      },
    });

    DocstoreMetrics.recordRead();
    return records.map((r) => this.mapToEntity(r));
  }

  public async getAllDeletedDocs(projectId: string): Promise<TextDoc[]> {
    const records = await this.prisma.manuscriptDoc.findMany({
      where: {
        projectId,
        deleted: true,
      },
      orderBy: {
        deletedAt: 'desc',
      },
      take: 100, // Matches Overleaf max_deleted_docs limit
    });

    return records.map((r) => this.mapToEntity(r));
  }

  public async createDoc(data: CreateDocData): Promise<TextDoc> {
    const cleanPath = data.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const bytes = data.lines.reduce(
      (acc, l) => acc + Buffer.byteLength(l, 'utf8'),
      0,
    );
    const sizeBytes = bytes + Math.max(0, data.lines.length - 1);

    const client = (data.tx as any) ?? this.prisma;
    const record = await client.manuscriptDoc.create({
      data: {
        projectId: data.projectId,
        path: cleanPath,
        lines: data.lines,
        rev: 1,
        version: data.version ?? 0,
        ranges: (data.ranges || {
          changes: [],
          comments: [],
        }) as unknown as Prisma.InputJsonValue,
        hash: data.hash || '',
        sizeBytes,
        inStorage: false,
        deleted: false,
      },
    });

    DocstoreMetrics.recordWrite(sizeBytes);
    return this.mapToEntity(record);
  }

  public async updateDoc(
    projectId: string,
    docId: string,
    data: UpdateDocData,
  ): Promise<{ doc: TextDoc; modified: boolean }> {
    let bytes = 0;
    const lines = data.lines;
    for (let i = 0; i < lines.length; i++) {
      bytes += Buffer.byteLength(lines[i], 'utf8');
    }
    const sizeBytes = bytes + Math.max(0, lines.length - 1);

    // 1. Optimistic Concurrency Control (OCC) check if expectedRev specified
    if (data.expectedRev !== undefined) {
      let baseDoc = data.currentDoc;
      if (!baseDoc) {
        const current = await this.prisma.manuscriptDoc.findFirst({
          where: { id: docId, projectId },
        });

        if (!current) {
          throw new DocNotFoundError(
            `Document ${docId} not found in project ${projectId}`,
          );
        }
        baseDoc = this.mapToEntity(current);
      }

      if (baseDoc.rev !== data.expectedRev) {
        DocstoreMetrics.recordOccConflict();
        throw new DocModifiedError(
          `Optimistic concurrency conflict on doc ${docId}: expected rev ${data.expectedRev} but current is ${baseDoc.rev}`,
          {
            docId,
            rev: data.expectedRev,
            currentRev: baseDoc.rev,
          },
        );
      }

      const resolvedRanges: DocRanges = data.ranges
        ? {
            ...data.ranges,
            ...(data.ranges.review === undefined && baseDoc.ranges?.review
              ? { review: baseDoc.ranges.review }
              : {}),
          }
        : baseDoc.ranges;
      const resolvedHash = data.hash || baseDoc.hash;

      // Atomic compare-and-swap (CAS) via updateMany to guarantee zero TOCTOU race condition
      const updateResult = await this.prisma.manuscriptDoc.updateMany({
        where: {
          id: docId,
          projectId,
          rev: data.expectedRev,
        },
        data: {
          lines: data.lines,
          version: data.version,
          ranges: resolvedRanges as unknown as Prisma.InputJsonValue,
          hash: resolvedHash,
          sizeBytes,
          inStorage: false,
          storageKey: null,
          rev: { increment: 1 },
        },
      });

      if (updateResult.count === 0) {
        const recheck = await this.prisma.manuscriptDoc.findFirst({
          where: { id: docId, projectId },
          select: { rev: true },
        });
        DocstoreMetrics.recordOccConflict();
        throw new DocModifiedError(
          `Optimistic concurrency conflict on doc ${docId}: expected rev ${data.expectedRev} but current is ${recheck?.rev ?? 'unknown'}`,
          {
            docId,
            rev: data.expectedRev,
            currentRev: recheck?.rev ?? data.expectedRev + 1,
          },
        );
      }

      const updatedDoc = new TextDoc({
        id: baseDoc.id,
        projectId: baseDoc.projectId,
        path: baseDoc.path,
        lines: data.lines,
        rev: data.expectedRev + 1,
        version: data.version,
        ranges: resolvedRanges,
        hash: resolvedHash,
        sizeBytes,
        inStorage: false,
        storageKey: null,
        deleted: baseDoc.deleted,
        deletedAt: baseDoc.deletedAt,
        createdAt: baseDoc.createdAt,
        updatedAt: new Date(),
      });

      DocstoreMetrics.recordWrite(sizeBytes);
      return { doc: updatedDoc, modified: true };
    }

    // 2. Direct atomic update in 1 single roundtrip when OCC revision check is not requested
    try {
      const updated = await this.prisma.manuscriptDoc.update({
        where: { id: docId },
        data: {
          lines: data.lines,
          version: data.version,
          ...(data.ranges !== undefined
            ? {
                ranges: data.ranges as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(data.hash ? { hash: data.hash } : {}),
          sizeBytes,
          inStorage: false,
          storageKey: null,
          rev: { increment: 1 },
        },
      });

      DocstoreMetrics.recordWrite(sizeBytes);
      return { doc: this.mapToEntity(updated), modified: true };
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new DocNotFoundError(
          `Document ${docId} not found in project ${projectId}`,
        );
      }
      throw err;
    }
  }

  public async patchDoc(
    projectId: string,
    docId: string,
    patch: PatchDocData,
  ): Promise<TextDoc> {
    const current = await this.prisma.manuscriptDoc.findFirst({
      where: { id: docId, projectId },
    });

    if (!current) {
      throw new DocNotFoundError(
        `Document ${docId} not found in project ${projectId}`,
      );
    }

    const updateData: Prisma.ManuscriptDocUpdateInput = {};
    if (patch.deleted !== undefined) {
      updateData.deleted = patch.deleted;
      updateData.deletedAt = patch.deleted
        ? patch.deletedAt || new Date()
        : null;
    }
    if (patch.name !== undefined) {
      updateData.path = patch.name.replace(/\\/g, '/').replace(/^\/+/, '');
    }
    if (patch.ranges !== undefined) {
      const existingRanges = (current.ranges as DocRanges) || {};
      updateData.ranges = {
        ...existingRanges,
        ...patch.ranges,
        ...(patch.ranges.review === undefined && existingRanges.review
          ? { review: existingRanges.review }
          : {}),
      } as unknown as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.manuscriptDoc.update({
      where: { id: docId },
      data: updateData,
    });

    return this.mapToEntity(updated);
  }

  public async markAsArchived(
    projectId: string,
    docId: string,
    storageKey: string,
    rev: number,
    clearLines = true,
  ): Promise<boolean> {
    const result = await this.prisma.manuscriptDoc.updateMany({
      where: {
        id: docId,
        projectId,
        rev,
      },
      data: {
        inStorage: true,
        storageKey,
        ...(clearLines ? { lines: [] } : {}),
      },
    });
    return (result?.count ?? 0) > 0;
  }

  public async unarchiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
    ranges?: DocRanges,
  ): Promise<TextDoc> {
    const bytes = lines.reduce(
      (acc, l) => acc + Buffer.byteLength(l, 'utf8'),
      0,
    );
    const sizeBytes = bytes + Math.max(0, lines.length - 1);

    await this.prisma.manuscriptDoc.updateMany({
      where: { id: docId, projectId, inStorage: true },
      data: {
        inStorage: false,
        storageKey: null,
        lines: lines,
        ranges: (ranges || {}) as unknown as Prisma.InputJsonValue,
        sizeBytes,
      },
    });

    const current = await this.prisma.manuscriptDoc.findFirst({
      where: { id: docId, projectId },
    });
    if (current) {
      return this.mapToEntity(current);
    }

    const fallback = await this.prisma.manuscriptDoc.findUnique({
      where: { id: docId },
    });
    return this.mapToEntity(fallback!);
  }

  public async destroyDoc(projectId: string, docId: string): Promise<boolean> {
    const result = await this.prisma.manuscriptDoc.deleteMany({
      where: { id: docId, projectId },
    });
    return result.count > 0;
  }

  public async destroyAllDocs(projectId: string): Promise<number> {
    const result = await this.prisma.manuscriptDoc.deleteMany({
      where: { projectId },
    });
    return result.count;
  }
}
