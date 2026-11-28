/**
 * history/history.repository.ts
 * Prisma Persistence Repository & Domain Mapper for 3NF History Schema
 * (HistoryBlob, PageSnapshot, PageSnapshotFile, PageSnapshotLabel).
 */

import {
  Injectable,
  Inject,
  Optional,
  ConflictException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { PrismaService } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import { ensureCanonicalPageId } from '@/modules/pages/core/utils/page-scope';
import {
  HistoryBlob as PrismaBlob,
  PageSnapshot as PrismaSnapshot,
  PageSnapshotFile as PrismaSnapshotFile,
  PageSnapshotLabel as PrismaLabel,
} from '@prisma/client';
import { Snapshot } from './domain/snapshot';
import { VersionLabel } from './domain/label';
import { FileSnapshotVo } from './domain/snapshot';
import { SnapshotNormalizer, RawSnapshotFileEntry } from './domain/snapshot';

export type { RawSnapshotFileEntry };

export type PrismaSnapshotFileWithBlob = PrismaSnapshotFile & {
  blob?: PrismaBlob | null;
};

export type PrismaLabelWithSnapshot = PrismaLabel & {
  snapshot?: { spaceId: string; version: number } | null;
  spaceId?: string;
  projectId?: string;
  version?: number;
};

export type PrismaSnapshotWithRelations = PrismaSnapshot & {
  files?: PrismaSnapshotFileWithBlob[] | unknown;
  labels?: PrismaLabelWithSnapshot[];
  _count?: { files?: number };
};

function computeContentHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class HistoryMapper {
  public static toDomainLabel(
    prisma: PrismaLabelWithSnapshot,
    fallbackContext?: { spaceId?: string; version?: number },
  ): VersionLabel {
    const spaceId =
      prisma.snapshot?.spaceId ??
      prisma.spaceId ??
      prisma.projectId ??
      fallbackContext?.spaceId ??
      '';
    const version =
      prisma.snapshot?.version ??
      prisma.version ??
      fallbackContext?.version ??
      1;
    return VersionLabel.create({
      id: prisma.id,
      projectId: spaceId,
      spaceId,
      pageId: prisma.pageId,
      snapshotId: prisma.snapshotId,
      version,
      label: prisma.label,
      createdById: prisma.createdById,
      createdAt: prisma.createdAt,
      updatedAt: prisma.updatedAt,
    });
  }

  public static parseSnapshotFiles(
    rawFiles: unknown,
  ): Map<string, FileSnapshotVo> {
    if (Array.isArray(rawFiles)) {
      const map = new Map<string, FileSnapshotVo>();
      for (const row of rawFiles as PrismaSnapshotFileWithBlob[]) {
        const pathname = row.pathname.startsWith('/')
          ? row.pathname
          : `/${row.pathname}`;
        const trimmedHash = (row.contentHash || '').trim();
        if (row.kind === 'file') {
          map.set(
            pathname,
            FileSnapshotVo.createFile(
              pathname,
              row.entityId ?? '',
              trimmedHash,
              row.blob?.sizeBytes ?? 0,
              row.blob?.storageKey ?? null,
            ),
          );
        } else {
          const text = row.blob?.content ?? '';
          map.set(
            pathname,
            FileSnapshotVo.createDoc(
              pathname,
              row.entityId ?? '',
              text.split('\n'),
              trimmedHash,
              row.isRoot,
            ),
          );
        }
      }
      return map;
    }
    return SnapshotNormalizer.parseSnapshotFiles(rawFiles);
  }

  public static toDomainHeader(record: {
    id: string;
    spaceId?: string;
    projectId?: string;
    pageId?: string;
    version: number;
    summary: string | null;
    createdById: string | null;
    isAutomatic: boolean;
    createdAt: Date;
    files?: unknown;
    fileCount?: number;
    totalBytes?: number;
    _count?: { files?: number };
    labels?: PrismaLabelWithSnapshot[];
  }): Snapshot {
    const spaceId = record.spaceId ?? record.projectId ?? '';
    const labels = record.labels
      ? record.labels.map((l) =>
          this.toDomainLabel(l, { spaceId, version: record.version }),
        )
      : [];
    const resolvedFileCount =
      record._count?.files ??
      record.fileCount ??
      (Array.isArray(record.files) ? record.files.length : 0);

    return Snapshot.create({
      id: record.id,
      projectId: spaceId,
      spaceId,
      pageId: record.pageId,
      version: record.version,
      summary: record.summary,
      createdById: record.createdById,
      isAutomatic: record.isAutomatic,
      files: new Map(),
      fileCount: resolvedFileCount,
      labels,
      createdAt: record.createdAt,
    });
  }

  public static toDomain(
    prisma: PrismaSnapshotWithRelations & { projectId?: string },
  ): Snapshot {
    const spaceId = prisma.spaceId ?? prisma.projectId ?? '';
    const filesMap = this.parseSnapshotFiles(prisma.files);
    const labels = prisma.labels
      ? prisma.labels.map((l) =>
          this.toDomainLabel(l, { spaceId, version: prisma.version }),
        )
      : [];

    return Snapshot.create({
      id: prisma.id,
      projectId: spaceId,
      spaceId,
      pageId: prisma.pageId,
      version: prisma.version,
      summary: prisma.summary,
      createdById: prisma.createdById,
      isAutomatic: prisma.isAutomatic,
      files: filesMap,
      labels,
      createdAt: prisma.createdAt,
    });
  }
}

@Injectable()
export class HistoryRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {}

  private async resolveFileBlobId(params: {
    blobId?: string | null;
    storageKey?: string | null;
    contentHash?: string | null;
  }): Promise<string | null> {
    if (params.blobId && isUUID(params.blobId)) {
      return params.blobId;
    }

    const cleanKey = params.storageKey?.trim() || null;
    if (cleanKey && this.prisma.fileBlob?.findFirst) {
      const byKey = await Promise.resolve(
        this.prisma.fileBlob.findFirst({
          where: { storageKey: cleanKey },
          select: { id: true },
        }),
      ).catch(() => null);
      if (byKey?.id) return byKey.id;
    }

    const cleanHash = params.contentHash?.trim().toLowerCase() || '';
    if (/^[0-9a-f]{64}$/.test(cleanHash)) {
      if (typeof this.filesPort?.findBlobByHash === 'function') {
        const byPort = await this.filesPort
          .findBlobByHash(cleanHash)
          .catch(() => null);
        if (byPort?.id) return byPort.id;
      }
      if (this.prisma.fileBlob?.findFirst) {
        const byHash = await Promise.resolve(
          this.prisma.fileBlob.findFirst({
            where: { contentHash: Buffer.from(cleanHash, 'hex') },
            select: { id: true },
          }),
        ).catch(() => null);
        if (byHash?.id) return byHash.id;
      }
    }

    return null;
  }

  public toDomain(record: PrismaSnapshotWithRelations): Snapshot {
    return HistoryMapper.toDomain(record);
  }

  private async resolveTargetPageId(
    projectId: string,
    pageId?: string,
  ): Promise<string> {
    return ensureCanonicalPageId(this.prisma, projectId, pageId);
  }

  private async resolveNextVersion(
    projectId: string,
    fallbackVersion: number,
    pageId?: string,
  ): Promise<number> {
    const canonicalPageId = await this.resolveTargetPageId(projectId, pageId);
    const agg = await this.prisma.pageSnapshot.aggregate({
      where: { spaceId: projectId, pageId: canonicalPageId },
      _max: { version: true },
    });
    return Math.max(fallbackVersion, (agg?._max?.version ?? 0) + 1);
  }

  public async saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    let candidateVersion = snapshot.version;
    const maxAttempts = 3;
    const canonicalPageId = await this.resolveTargetPageId(
      snapshot.projectId,
      snapshot.pageId,
    );

    const blobMap = new Map<
      string,
      {
        contentHash: string;
        content: string | null;
        sizeBytes: number;
        inStorage: boolean;
        storageKey: string | null;
        blobId: string | null;
      }
    >();
    const fileRows: Array<{
      pathname: string;
      kind: string;
      isRoot: boolean;
      entityId: string | null;
      contentHash: string;
    }> = [];
    let totalBytes = 0;

    for (const [pathname, vo] of snapshot.files.entries()) {
      const isDoc = vo.type === 'doc';
      const content = isDoc ? (vo.lines ?? []).join('\n') : null;

      let resolvedStorageKey = !isDoc ? (vo.storageKey ?? null) : null;
      let resolvedBlobId = !isDoc ? (vo.blobId ?? null) : null;
      let fallbackFileHash = '';
      let fallbackSizeBytes: number | undefined;

      if (
        !isDoc &&
        (!resolvedStorageKey || !vo.hash || !resolvedBlobId) &&
        vo.fileId &&
        isUUID(vo.fileId) &&
        this.prisma.pageFile?.findUnique
      ) {
        const pageFile = await Promise.resolve(
          this.prisma.pageFile.findUnique({
            where: { id: vo.fileId },
            select: {
              storageKey: true,
              hash: true,
              blobId: true,
              sizeBytes: true,
            },
          }),
        ).catch(() => null);
        if (pageFile) {
          resolvedStorageKey = resolvedStorageKey ?? pageFile.storageKey ?? null;
          resolvedBlobId = resolvedBlobId ?? pageFile.blobId ?? null;
          fallbackFileHash = pageFile.hash ?? '';
          fallbackSizeBytes = pageFile.sizeBytes;
        }
      }

      const sizeBytes = isDoc
        ? Buffer.byteLength(content ?? '', 'utf8')
        : (vo.sizeBytes || fallbackSizeBytes || 0);
      totalBytes += sizeBytes;

      const candidateHash = (vo.hash || fallbackFileHash || '')
        .trim()
        .toLowerCase();
      const rawHash = isDoc
        ? /^[0-9a-f]{64}$/.test(candidateHash)
          ? candidateHash
          : computeContentHash(content ?? '')
        : /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(candidateHash)
          ? candidateHash
          : computeContentHash(
              `${pathname}:${vo.fileId ?? ''}:${resolvedStorageKey ?? ''}:${sizeBytes}`,
            );

      const existingEntry = blobMap.get(rawHash);
      if (!existingEntry) {
        blobMap.set(rawHash, {
          contentHash: rawHash,
          content,
          sizeBytes,
          inStorage: !isDoc,
          storageKey: resolvedStorageKey,
          blobId: resolvedBlobId,
        });
      } else if (!isDoc && !existingEntry.storageKey && resolvedStorageKey) {
        existingEntry.storageKey = resolvedStorageKey;
        existingEntry.blobId = existingEntry.blobId ?? resolvedBlobId;
      }

      const rawEntityId = isDoc ? vo.docId : vo.fileId;
      fileRows.push({
        pathname,
        kind: isDoc ? 'doc' : 'file',
        isRoot: Boolean(vo.isRootDoc),
        entityId: rawEntityId && isUUID(rawEntityId) ? rawEntityId : null,
        contentHash: rawHash,
      });
    }

    const docBlobs: Array<{
      contentHash: string;
      content: string | null;
      sizeBytes: number;
      inStorage: boolean;
      storageKey: string | null;
    }> = [];
    const binaryBlobs: Array<{
      contentHash: string;
      content: string | null;
      sizeBytes: number;
      inStorage: boolean;
      storageKey: string | null;
      blobId: string | null;
    }> = [];

    for (const b of blobMap.values()) {
      if (b.inStorage) {
        binaryBlobs.push(b);
      } else {
        docBlobs.push({
          contentHash: b.contentHash,
          content: b.content,
          sizeBytes: b.sizeBytes,
          inStorage: false,
          storageKey: null,
        });
      }
    }

    if (docBlobs.length > 0 && this.prisma.historyBlob?.createMany) {
      await this.prisma.historyBlob.createMany({
        data: docBlobs,
        skipDuplicates: true,
      });
    }

    if (binaryBlobs.length > 0 && this.prisma.historyBlob) {
      const binaryHashes = binaryBlobs.map((b) => b.contentHash);
      const existingRows = this.prisma.historyBlob.findMany
        ? await Promise.resolve(
            this.prisma.historyBlob.findMany({
              where: { contentHash: { in: binaryHashes } },
              select: { contentHash: true, storageKey: true },
            }),
          ).catch(() => [])
        : [];
      const existingMap = new Map<string, string | null>();
      for (const r of existingRows || []) {
        existingMap.set((r.contentHash || '').trim(), r.storageKey ?? null);
      }

      for (const b of binaryBlobs) {
        const hasExisting = existingMap.has(b.contentHash);
        const prevStorageKey = existingMap.get(b.contentHash) ?? null;

        if (hasExisting) {
          if (
            !prevStorageKey &&
            b.storageKey &&
            this.prisma.historyBlob.updateMany
          ) {
            const updated = await Promise.resolve(
              this.prisma.historyBlob.updateMany({
                where: { contentHash: b.contentHash, storageKey: null },
                data: { storageKey: b.storageKey, inStorage: true },
              }),
            ).catch(() => ({ count: 0 }));
            if (
              updated.count > 0 &&
              typeof this.filesPort?.acquireBlob === 'function'
            ) {
              const targetBlobId = await this.resolveFileBlobId({
                blobId: b.blobId,
                storageKey: b.storageKey,
                contentHash: b.contentHash,
              });
              if (targetBlobId) {
                await this.filesPort.acquireBlob(targetBlobId).catch(() => null);
              }
            }
          }
          continue;
        }

        const createPayload = {
          contentHash: b.contentHash,
          content: null,
          sizeBytes: b.sizeBytes,
          inStorage: true,
          storageKey: b.storageKey,
        };

        let insertedNew = false;
        if (typeof this.prisma.historyBlob.create === 'function') {
          try {
            await this.prisma.historyBlob.create({ data: createPayload });
            insertedNew = true;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code !== 'P2002') throw err;
          }
        } else if (typeof this.prisma.historyBlob.createMany === 'function') {
          const res = await this.prisma.historyBlob.createMany({
            data: [createPayload],
            skipDuplicates: true,
          });
          insertedNew = (res?.count ?? 1) > 0;
        }

        if (
          insertedNew &&
          b.storageKey &&
          typeof this.filesPort?.acquireBlob === 'function'
        ) {
          const targetBlobId = await this.resolveFileBlobId({
            blobId: b.blobId,
            storageKey: b.storageKey,
            contentHash: b.contentHash,
          });
          if (targetBlobId) {
            await this.filesPort.acquireBlob(targetBlobId).catch(() => null);
          }
        }
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const created = await this.prisma.pageSnapshot.create({
          data: {
            id: snapshot.id,
            spaceId: snapshot.projectId,
            pageId: canonicalPageId,
            version: candidateVersion,
            summary: snapshot.summary,
            createdById: snapshot.createdById,
            isAutomatic: snapshot.isAutomatic,
            totalBytes,
            createdAt: snapshot.createdAt,
            ...(fileRows.length > 0 ? { files: { create: fileRows } } : {}),
          },
          include: {
            files: { include: { blob: true } },
            labels: true,
          },
        });
        return HistoryMapper.toDomain(created);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'P2002' && attempt < maxAttempts - 1) {
          candidateVersion = await this.resolveNextVersion(
            snapshot.projectId,
            candidateVersion + 1,
            canonicalPageId,
          );
          continue;
        }
        throw err;
      }
    }

    throw new ConflictException(
      `Failed to save immutable snapshot for project ${snapshot.projectId} after ${maxAttempts} attempts`,
    );
  }

  public async findByVersion(
    projectId: string,
    version: number,
    pageId?: string,
  ): Promise<Snapshot | null> {
    const canonicalPageId = await this.resolveTargetPageId(projectId, pageId);
    const found = await this.prisma.pageSnapshot.findFirst({
      where: {
        spaceId: projectId,
        pageId: canonicalPageId,
        version,
      },
      include: {
        files: { include: { blob: true } },
        labels: true,
      },
    });

    if (!found) return null;
    return HistoryMapper.toDomain(found);
  }

  public async getLatestVersion(
    projectId: string,
    pageId?: string,
  ): Promise<number> {
    const canonicalPageId = await this.resolveTargetPageId(projectId, pageId);
    const agg = await this.prisma.pageSnapshot.aggregate({
      where: { spaceId: projectId, pageId: canonicalPageId },
      _max: { version: true },
    });
    if (agg?._max?.version !== undefined) {
      return agg._max.version ?? 0;
    }
    const latest = await this.prisma.pageSnapshot.findFirst({
      where: { spaceId: projectId, pageId: canonicalPageId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return latest ? latest.version : 0;
  }

  public async listVersions(
    projectId: string,
    pageId?: string,
  ): Promise<Snapshot[]> {
    const canonicalPageId = await this.resolveTargetPageId(projectId, pageId);
    const records = await this.prisma.pageSnapshot.findMany({
      where: { spaceId: projectId, pageId: canonicalPageId },
      orderBy: { version: 'desc' },
      take: 500,
      select: {
        id: true,
        spaceId: true,
        pageId: true,
        version: true,
        summary: true,
        createdById: true,
        isAutomatic: true,
        totalBytes: true,
        createdAt: true,
        labels: true,
        _count: { select: { files: true } },
      },
    });

    return records.reverse().map((r) => HistoryMapper.toDomainHeader(r));
  }

  public async saveLabel(label: VersionLabel): Promise<VersionLabel> {
    const snapRow = this.prisma.pageSnapshot?.findUnique
      ? await Promise.resolve(
          this.prisma.pageSnapshot.findUnique({
            where: { id: label.snapshotId },
            select: { pageId: true, spaceId: true, version: true },
          }),
        ).catch(() => null)
      : null;
    const targetPageId =
      snapRow?.pageId ||
      (await this.resolveTargetPageId(label.projectId, label.pageId));

    const existing = await this.prisma.pageSnapshotLabel.findFirst?.({
      where: {
        pageId: targetPageId,
        label: label.label,
      },
    });

    const saved = existing
      ? await this.prisma.pageSnapshotLabel.update({
          where: { id: existing.id },
          data: {
            snapshotId: label.snapshotId,
            label: label.label,
            updatedAt: label.updatedAt,
          },
          include: { snapshot: { select: { spaceId: true, version: true } } },
        })
      : await this.prisma.pageSnapshotLabel.create({
          data: {
            id: label.id,
            pageId: targetPageId,
            snapshotId: label.snapshotId,
            label: label.label,
            createdById: label.createdById,
            createdAt: label.createdAt,
            updatedAt: label.updatedAt,
          },
          include: { snapshot: { select: { spaceId: true, version: true } } },
        });

    return HistoryMapper.toDomainLabel(saved, {
      spaceId: snapRow?.spaceId ?? label.projectId,
      version: snapRow?.version ?? label.version,
    });
  }

  public async deleteLabel(
    projectId: string,
    labelId: string,
    pageId?: string,
  ): Promise<void> {
    const canonicalPageId = pageId
      ? await this.resolveTargetPageId(projectId, pageId)
      : undefined;
    await this.prisma.pageSnapshotLabel.deleteMany({
      where: {
        id: labelId,
        snapshot: { spaceId: projectId },
        ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
      },
    });
  }

  public async findLabelByName(
    projectId: string,
    label: string,
    pageId?: string,
  ): Promise<VersionLabel | null> {
    const canonicalPageId = await this.resolveTargetPageId(projectId, pageId);
    const found = await this.prisma.pageSnapshotLabel.findFirst({
      where: {
        pageId: canonicalPageId,
        label,
        snapshot: { spaceId: projectId },
      },
      include: { snapshot: { select: { spaceId: true, version: true } } },
    });

    if (!found) return null;
    return HistoryMapper.toDomainLabel(found, { spaceId: projectId });
  }

  public async listLabels(
    spaceId: string,
    pageId?: string,
  ): Promise<VersionLabel[]> {
    const canonicalPageId = pageId
      ? await this.resolveTargetPageId(spaceId, pageId)
      : undefined;
    const rows = await this.prisma.pageSnapshotLabel.findMany({
      where: {
        snapshot: { spaceId },
        ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
      },
      include: { snapshot: { select: { spaceId: true, version: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => HistoryMapper.toDomainLabel(row, { spaceId }));
  }

  public async findBlobInSpace(
    spaceId: string,
    contentHash: string,
  ): Promise<{
    contentHash: string;
    content: string | null;
    sizeBytes: number;
    inStorage: boolean;
    storageKey: string | null;
  } | null> {
    const match = await this.prisma.pageSnapshotFile.findFirst({
      where: {
        contentHash,
        snapshot: { spaceId },
      },
      include: { blob: true },
    });
    if (!match?.blob) return null;
    return {
      contentHash: (match.blob.contentHash || '').trim(),
      content: match.blob.content,
      sizeBytes: match.blob.sizeBytes,
      inStorage: match.blob.inStorage,
      storageKey: match.blob.storageKey,
    };
  }

  public async findSnapshotInProject(
    projectId: string,
    versionOrId: string | number,
  ): Promise<PrismaSnapshotWithRelations | null> {
    if (typeof versionOrId === 'number' || !isNaN(Number(versionOrId))) {
      const snap = await this.prisma.pageSnapshot.findFirst({
        where: { spaceId: projectId, version: Number(versionOrId) },
        include: { files: { include: { blob: true } }, labels: true },
      });
      if (snap) return snap;
      return this.prisma.pageSnapshot
        .findFirst({
          where: { pageId: projectId, version: Number(versionOrId) },
          include: { files: { include: { blob: true } }, labels: true },
        })
        .catch(() => null);
    }

    if (isUUID(String(versionOrId))) {
      const snap = await this.prisma.pageSnapshot.findFirst({
        where: { id: String(versionOrId), spaceId: projectId },
        include: { files: { include: { blob: true } }, labels: true },
      });
      if (snap) return snap;
      return this.prisma.pageSnapshot
        .findFirst({
          where: { id: String(versionOrId), pageId: projectId },
          include: { files: { include: { blob: true } }, labels: true },
        })
        .catch(() => null);
    }

    return null;
  }

  /**
   * Garbage-collects unreferenced HistoryBlob records (0 PageSnapshotFile references)
   * and decrements CAS FileBlob refCounts for unreferenced binary blobs.
   */
  public async gcOrphanBlobs(): Promise<number> {
    let deletedBinaryCount = 0;

    if (this.prisma.historyBlob?.findMany) {
      const orphanBinaryBlobs = await Promise.resolve(
        this.prisma.historyBlob.findMany({
          where: {
            snapshotFiles: { none: {} },
            inStorage: true,
            storageKey: { not: null },
          },
          select: {
            contentHash: true,
            storageKey: true,
          },
        }),
      ).catch(() => []);

      for (const orphan of orphanBinaryBlobs || []) {
        const delRes = await this.prisma.historyBlob.deleteMany({
          where: {
            contentHash: orphan.contentHash,
            snapshotFiles: { none: {} },
          },
        });
        if (delRes.count > 0) {
          deletedBinaryCount += delRes.count;
          if (
            orphan.storageKey &&
            typeof this.filesPort?.releaseBlob === 'function'
          ) {
            const targetBlobId = await this.resolveFileBlobId({
              storageKey: orphan.storageKey,
              contentHash: orphan.contentHash,
            });
            if (targetBlobId) {
              await this.filesPort
                .releaseBlob(targetBlobId)
                .catch(() => undefined);
            }
          }
        }
      }
    }

    const result = await this.prisma.historyBlob.deleteMany({
      where: {
        snapshotFiles: { none: {} },
      },
    });
    return deletedBinaryCount + result.count;
  }

  /**
   * Compacts old automatic snapshots older than `olderThanDays` to at most 1 per (pageId, UTC day).
   * Strictly preserves all manual snapshots (`isAutomatic: false`) and any labelled snapshots.
   */
  public async compactAutoSnapshots(
    spaceId?: string,
    olderThanDays = 30,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.pageSnapshot.findMany({
      where: {
        ...(spaceId ? { spaceId } : {}),
        isAutomatic: true,
        createdAt: { lt: cutoff },
        labels: { none: {} },
      },
      select: { id: true, spaceId: true, pageId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const keptBuckets = new Set<string>();
    const idsToDelete: string[] = [];

    for (const snap of candidates) {
      const dayKey = snap.createdAt.toISOString().slice(0, 10);
      const bucket = `${snap.spaceId}:${snap.pageId ?? '*'}:${dayKey}`;
      if (keptBuckets.has(bucket)) {
        idsToDelete.push(snap.id);
      } else {
        keptBuckets.add(bucket);
      }
    }

    if (idsToDelete.length === 0) return 0;

    const deleted = await this.prisma.pageSnapshot.deleteMany({
      where: { id: { in: idsToDelete } },
    });
    return deleted.count;
  }
}
