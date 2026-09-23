/**
 * modules/manuscripts/docstore/core/adapters/database/prisma-doc.repository.ts
 * PostgreSQL repository implementation via Prisma with Optimistic Concurrency Control (OCC).
 * Matches Overleaf MongoManager.js semantics.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  IDocRepository,
  CreateDocData,
  UpdateDocData,
  PatchDocData,
} from '../../ports/doc-repository.port';
import { TextDoc } from '../../domain/text-doc.entity';
import { DocModifiedError, DocNotFoundError } from '../../domain/doc-errors';
import { DocRanges } from '../../domain/doc-range.vo';
import { DocstoreMetrics } from '../telemetry/docstore.metrics';

@Injectable()
export class PrismaDocRepository implements IDocRepository {
  private readonly logger = new Logger(PrismaDocRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private mapToEntity(record: any): TextDoc {
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

  public async getDoc(projectId: string, docId: string): Promise<TextDoc | null> {
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

  public async getDocByPath(projectId: string, path: string): Promise<TextDoc | null> {
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
    const chars = data.lines.reduce((acc, l) => acc + l.length, 0);
    const sizeBytes = chars + Math.max(0, data.lines.length - 1);

    const record = await this.prisma.manuscriptDoc.create({
      data: {
        projectId: data.projectId,
        path: cleanPath,
        lines: data.lines as any,
        rev: 1,
        version: data.version ?? 0,
        ranges: (data.ranges || { changes: [], comments: [] }) as any,
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
    data: UpdateDocData
  ): Promise<{ doc: TextDoc; modified: boolean }> {
    // 1. Fetch current document state to check revision for OCC
    const current = await this.prisma.manuscriptDoc.findFirst({
      where: { id: docId, projectId },
    });

    if (!current) {
      throw new DocNotFoundError(`Document ${docId} not found in project ${projectId}`);
    }

    // 2. Optimistic Concurrency Control (OCC) check
    if (data.expectedRev !== undefined && current.rev !== data.expectedRev) {
      DocstoreMetrics.recordOccConflict();
      throw new DocModifiedError(
        `Optimistic concurrency conflict on doc ${docId}: expected rev ${data.expectedRev} but current is ${current.rev}`,
        {
          docId,
          rev: data.expectedRev,
          currentRev: current.rev,
        }
      );
    }

    const chars = data.lines.reduce((acc, l) => acc + l.length, 0);
    const sizeBytes = chars + Math.max(0, data.lines.length - 1);

    // 3. Atomic update with incremented revision
    const updated = await this.prisma.manuscriptDoc.update({
      where: { id: docId },
      data: {
        lines: data.lines as any,
        version: data.version,
        ranges: (data.ranges || current.ranges) as any,
        hash: data.hash || current.hash,
        sizeBytes,
        inStorage: false,
        storageKey: null,
        rev: { increment: 1 },
      },
    });

    DocstoreMetrics.recordWrite(sizeBytes);
    return { doc: this.mapToEntity(updated), modified: true };
  }

  public async patchDoc(
    projectId: string,
    docId: string,
    patch: PatchDocData
  ): Promise<TextDoc> {
    const current = await this.prisma.manuscriptDoc.findFirst({
      where: { id: docId, projectId },
    });

    if (!current) {
      throw new DocNotFoundError(`Document ${docId} not found in project ${projectId}`);
    }

    const updateData: any = {};
    if (patch.deleted !== undefined) {
      updateData.deleted = patch.deleted;
      updateData.deletedAt = patch.deleted ? (patch.deletedAt || new Date()) : null;
    }
    if (patch.name !== undefined) {
      updateData.path = patch.name.replace(/\\/g, '/').replace(/^\/+/, '');
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
    rev: number
  ): Promise<void> {
    await this.prisma.manuscriptDoc.updateMany({
      where: {
        id: docId,
        projectId,
        rev,
      },
      data: {
        inStorage: true,
        storageKey,
        lines: [] as any,
      },
    });
  }

  public async unarchiveDoc(
    projectId: string,
    docId: string,
    lines: string[],
    ranges?: DocRanges
  ): Promise<TextDoc> {
    const chars = lines.reduce((acc, l) => acc + l.length, 0);
    const sizeBytes = chars + Math.max(0, lines.length - 1);

    const updated = await this.prisma.manuscriptDoc.update({
      where: { id: docId },
      data: {
        inStorage: false,
        storageKey: null,
        lines: lines as any,
        ranges: (ranges || {}) as any,
        sizeBytes,
        rev: { increment: 1 },
      },
    });

    return this.mapToEntity(updated);
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
