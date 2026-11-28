/**
 * modules/pages/docstore/repositories/docstore.repository.ts
 * Direct PostgreSQL repository via Prisma with Optimistic Concurrency Control (OCC).
 * Eliminates unnecessary single-adapter Symbol port indirection while preserving
 * backward-compatible types and aliases.
 */

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, PageDoc } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  NodePathVo,
  ensureCanonicalPageId,
  ensurePrismaFolderChain,
  filterRecordsByPageScope,
} from '@/modules/pages/core';
import { TextDoc } from '../domain/text-doc.entity';
import { DocModifiedError, DocNotFoundError } from '../domain/doc.errors';
import { DocRanges } from '../domain/doc-range';
import {
  DocstoreMetrics,
  CreateDocData,
  UpdateDocData,
  PatchDocData,
} from '../domain/doc.ports';

export type { CreateDocData, UpdateDocData, PatchDocData };

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function computeLinesByteSize(lines: readonly string[]): number {
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    bytes += Buffer.byteLength(lines[i], 'utf8');
  }
  return bytes + Math.max(0, lines.length - 1);
}

@Injectable()
export class DocstoreRepository {
  private readonly logger = new Logger(DocstoreRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private mapToEntity(
    record: PageDoc & { node?: { path?: string | null } | null; path?: string },
  ): TextDoc {
    const rawLines = Array.isArray(record.lines)
      ? (record.lines as string[])
      : typeof record.lines === 'string'
        ? record.lines.split('\n')
        : [];
    const projectId =
      record.spaceId ?? (record as { projectId?: string }).projectId ?? '';
    const resolvedPath =
      record.node?.path ||
      record.lastKnownPath ||
      record.path ||
      'document.tex';

    return new TextDoc({
      id: record.id,
      projectId,
      pageId: record.pageId ?? projectId,
      path: resolvedPath,
      lines: rawLines,
      rev: record.rev,
      version: record.version,
      ranges: (record.ranges as DocRanges) || { changes: [], comments: [] },
      hash: record.hash || '',
      sizeBytes: record.sizeBytes,
      inStorage: record.inStorage,
      storageKey: record.storageKey,
      deleted: Boolean(
        record.deletedAt ?? (record as { deleted?: boolean }).deleted,
      ),
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

    const record = await this.prisma.pageDoc.findFirst({
      where: {
        id: docId,
        spaceId: projectId,
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

    const record = await this.prisma.pageDoc.findUnique({
      where: { id: docId },
    });

    DocstoreMetrics.recordRead();
    if (!record) return null;
    return this.mapToEntity(record);
  }

  public async getAllDocs(
    projectId: string,
    pageId?: string,
  ): Promise<TextDoc[]> {
    const hasPageScope = Boolean(pageId && isUuid(pageId));
    const rawRecords = await this.prisma.pageDoc.findMany({
      where: {
        spaceId: projectId,
        deletedAt: null,
        ...(hasPageScope ? { pageId } : {}),
      },
      orderBy: {
        lastKnownPath: 'asc',
      },
    });

    const records = hasPageScope
      ? filterRecordsByPageScope(rawRecords, pageId, projectId)
      : rawRecords;

    DocstoreMetrics.recordRead();
    return records.map((r) => this.mapToEntity(r));
  }

  public async getAllDeletedDocs(
    projectId: string,
    pageId?: string,
  ): Promise<TextDoc[]> {
    const hasScopedPage =
      typeof pageId === 'string' && pageId !== projectId && isUuid(pageId);
    const records = await this.prisma.pageDoc.findMany({
      where: {
        spaceId: projectId,
        deletedAt: { not: null },
        ...(hasScopedPage ? { pageId } : {}),
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
    const sizeBytes = computeLinesByteSize(data.lines);

    const client = data.tx ?? this.prisma;
    const effectivePageId = await ensureCanonicalPageId(
      client,
      data.projectId,
      data.pageId,
      { preferredPageId: data.id },
    );
    const record = await client.pageDoc.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        spaceId: data.projectId,
        pageId: effectivePageId,
        lastKnownPath: cleanPath,
        lines: data.lines,
        rev: 1,
        version: data.version ?? 0,
        ranges: toInputJson(
          data.ranges || {
            changes: [],
            comments: [],
          },
        ),
        hash: data.hash || '',
        sizeBytes,
        inStorage: false,
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
    const sizeBytes = computeLinesByteSize(data.lines);

    // 1. Optimistic Concurrency Control (OCC) check if expectedRev specified
    if (data.expectedRev !== undefined) {
      let baseDoc = data.currentDoc;
      if (!baseDoc) {
        const current = await this.prisma.pageDoc.findFirst({
          where: { id: docId, spaceId: projectId },
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
      const updateResult = await this.prisma.pageDoc.updateMany({
        where: {
          id: docId,
          spaceId: projectId,
          rev: data.expectedRev,
          deletedAt: null,
        },
        data: {
          lines: data.lines,
          version: data.version,
          ranges: toInputJson(resolvedRanges),
          hash: resolvedHash,
          sizeBytes,
          inStorage: false,
          storageKey: null,
          rev: { increment: 1 },
        },
      });

      if (updateResult.count === 0) {
        const recheck = await this.prisma.pageDoc.findFirst({
          where: { id: docId, spaceId: projectId },
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
        pageId: baseDoc.pageId,
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

    // 2. Direct tenant-scoped atomic update when OCC revision check is not requested
    const directResult = await this.prisma.pageDoc.updateMany({
      where: {
        id: docId,
        spaceId: projectId,
        deletedAt: null,
      },
      data: {
        lines: data.lines,
        version: data.version,
        ...(data.ranges !== undefined
          ? {
              ranges: toInputJson(data.ranges),
            }
          : {}),
        ...(data.hash ? { hash: data.hash } : {}),
        sizeBytes,
        inStorage: false,
        storageKey: null,
        rev: { increment: 1 },
      },
    });

    if (directResult.count === 0) {
      throw new DocNotFoundError(
        `Document ${docId} not found in space ${projectId}`,
      );
    }

    const updated = await this.prisma.pageDoc.findFirst({
      where: { id: docId, spaceId: projectId, deletedAt: null },
    });
    if (!updated) {
      throw new DocNotFoundError(
        `Document ${docId} not found in space ${projectId}`,
      );
    }

    DocstoreMetrics.recordWrite(sizeBytes);
    return { doc: this.mapToEntity(updated), modified: true };
  }

  public async patchDoc(
    projectId: string,
    docId: string,
    patch: PatchDocData,
  ): Promise<TextDoc> {
    const current = await this.prisma.pageDoc.findFirst({
      where: { id: docId, spaceId: projectId },
    });

    if (!current) {
      throw new DocNotFoundError(
        `Document ${docId} not found in project ${projectId}`,
      );
    }

    const updateData: Prisma.PageDocUpdateInput = {};
    let nextLastKnownPath: string | undefined;
    if (patch.deleted !== undefined) {
      updateData.deletedAt = patch.deleted
        ? patch.deletedAt || new Date()
        : null;
    }
    if (patch.name !== undefined) {
      const parsedName = NodePathVo.parse(
        patch.name || 'document.tex',
        'document.tex',
      );
      nextLastKnownPath = parsedName.relativePath;
      updateData.lastKnownPath = nextLastKnownPath;
    }
    if (patch.ranges !== undefined) {
      const existingRanges = (current.ranges as DocRanges) || {};
      updateData.ranges = toInputJson({
        ...existingRanges,
        ...patch.ranges,
        ...(patch.ranges.review === undefined && existingRanges.review
          ? { review: existingRanges.review }
          : {}),
      });
    }

    const runPatch = async (
      db: Pick<PrismaService, 'pageDoc' | 'pageNode'>,
    ) => {
      const docRecord = await db.pageDoc.update({
        where: { id: docId },
        data: updateData,
      });

      if (patch.deleted === true) {
        await db.pageNode
          ?.deleteMany({
            where: {
              spaceId: projectId,
              OR: [{ docId }, { id: docId }],
            },
          })
          ?.catch(() => undefined);
      } else if (patch.name !== undefined && nextLastKnownPath) {
        const parsed = NodePathVo.parse(nextLastKnownPath, nextLastKnownPath);
        const parentId = await ensurePrismaFolderChain(
          db,
          projectId,
          parsed.folderChain,
          current.pageId,
        );
        await db.pageNode?.updateMany({
          where: {
            spaceId: projectId,
            OR: [{ docId }, { id: docId }],
          },
          data: {
            name: parsed.leafName,
            path: parsed.normalizedPath,
            depth: parsed.depth,
            parentId: parentId ?? null,
          },
        });
      }

      return docRecord;
    };

    try {
      const updated =
        typeof this.prisma.$transaction === 'function'
          ? await this.prisma.$transaction(async (tx) => {
              const client = tx?.pageDoc ? tx : this.prisma;
              return await runPatch(client);
            })
          : await runPatch(this.prisma);

      return this.mapToEntity(updated);
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string } | null;
      if (errObj?.code === 'P2002' || errObj?.message?.includes('P2002')) {
        throw new ConflictException(
          `File path already exists: ${nextLastKnownPath ?? patch.name ?? docId}`,
        );
      }
      throw err;
    }
  }

  public async markAsArchived(
    projectId: string,
    docId: string,
    storageKey: string,
    rev: number,
    clearLines = true,
  ): Promise<boolean> {
    const result = await this.prisma.pageDoc.updateMany({
      where: {
        id: docId,
        spaceId: projectId,
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
    const sizeBytes = computeLinesByteSize(lines);

    const existing =
      typeof this.prisma.pageDoc.findFirst === 'function'
        ? await this.prisma.pageDoc.findFirst({
            where: { id: docId, spaceId: projectId },
            select: { ranges: true },
          })
        : null;
    const existingRanges =
      existing?.ranges &&
      typeof existing.ranges === 'object' &&
      !Array.isArray(existing.ranges)
        ? (existing.ranges as Record<string, unknown>)
        : {};
    const incomingRanges =
      ranges && typeof ranges === 'object' && !Array.isArray(ranges)
        ? (ranges as Record<string, unknown>)
        : {};
    const mergedRanges = { ...existingRanges, ...incomingRanges };

    await this.prisma.pageDoc.updateMany({
      where: { id: docId, spaceId: projectId, inStorage: true },
      data: {
        inStorage: false,
        storageKey: null,
        lines: lines,
        ranges: toInputJson(mergedRanges),
        sizeBytes,
      },
    });

    const current = await this.prisma.pageDoc.findFirst({
      where: { id: docId, spaceId: projectId },
    });
    if (!current) {
      throw new DocNotFoundError(
        `Document ${docId} not found in space ${projectId}`,
      );
    }
    return this.mapToEntity(current);
  }

  public async destroyDoc(projectId: string, docId: string): Promise<boolean> {
    await this.prisma.pageNode
      ?.deleteMany({
        where: {
          spaceId: projectId,
          OR: [{ docId }, { id: docId }],
        },
      })
      ?.catch(() => undefined);
    const result = await this.prisma.pageDoc.deleteMany({
      where: { id: docId, spaceId: projectId },
    });
    return result.count > 0;
  }
}
