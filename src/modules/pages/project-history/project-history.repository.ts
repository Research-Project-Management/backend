/**
 * project-history/project-history.repository.ts
 * Direct Injectable Prisma Persistence Repository & Domain Mapper for Project History Snapshots & Labels.
 */

import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ensureCanonicalPageId } from '@/modules/pages/core/page-scope.helper';
import {
  Prisma,
  PageSnapshot as PrismaSnapshot,
  PageSnapshotLabel as PrismaLabel,
} from '@prisma/client';
import {
  IHistoryRepositoryPort,
  Snapshot,
  VersionLabel,
  FileSnapshotVo,
  SnapshotNormalizer,
  RawSnapshotFileEntry,
} from './domain';

export type { RawSnapshotFileEntry };

export type PrismaSnapshotWithLabels = PrismaSnapshot & {
  labels?: PrismaLabel[];
};

export class ManuscriptHistoryMapper {
  public static toDomainLabel(
    prisma: PrismaLabel & { projectId?: string },
  ): VersionLabel {
    const spaceId = prisma.spaceId ?? prisma.projectId ?? '';
    return VersionLabel.create({
      id: prisma.id,
      projectId: spaceId,
      spaceId,
      pageId: prisma.pageId,
      snapshotId: prisma.snapshotId,
      version: prisma.version,
      label: prisma.label,
      createdById: prisma.createdById,
      createdAt: prisma.createdAt,
      updatedAt: prisma.updatedAt,
    });
  }

  public static parseSnapshotFiles(
    rawFiles: unknown,
  ): Map<string, FileSnapshotVo> {
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
    sizeBytes?: number;
    labels?: PrismaLabel[];
  }): Snapshot {
    const labels = record.labels
      ? record.labels.map((l) => this.toDomainLabel(l))
      : [];
    let resolvedFileCount = record.fileCount;
    if (resolvedFileCount === undefined) {
      if (
        record.files &&
        typeof record.files === 'object' &&
        !Array.isArray(record.files)
      ) {
        resolvedFileCount = Object.keys(
          record.files as Record<string, unknown>,
        ).filter((k) => !k.startsWith('__')).length;
      } else {
        resolvedFileCount = record.sizeBytes ?? 0;
      }
    }
    const spaceId = record.spaceId ?? record.projectId ?? '';
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
    prisma: PrismaSnapshotWithLabels & { projectId?: string },
  ): Snapshot {
    const filesMap = SnapshotNormalizer.parseSnapshotFiles(prisma.files);
    const labels = prisma.labels
      ? prisma.labels.map((l) => this.toDomainLabel(l))
      : [];
    const spaceId = prisma.spaceId ?? prisma.projectId ?? '';

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
export class ProjectHistoryRepository extends IHistoryRepositoryPort {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  public toDomain(record: PrismaSnapshotWithLabels): Snapshot {
    return ManuscriptHistoryMapper.toDomain(record);
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

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const filesJson = snapshot.toFilesJson() as Prisma.InputJsonValue;
        const sizeBytes = Buffer.byteLength(JSON.stringify(filesJson), 'utf8');
        const created = await this.prisma.pageSnapshot.create({
          data: {
            id: snapshot.id,
            spaceId: snapshot.projectId,
            pageId: canonicalPageId,
            version: candidateVersion,
            summary: snapshot.summary,
            createdById: snapshot.createdById,
            isAutomatic: snapshot.isAutomatic,
            files: filesJson,
            sizeBytes,
            createdAt: snapshot.createdAt,
          },
          include: {
            labels: true,
          },
        });
        return ManuscriptHistoryMapper.toDomain(created);
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
        labels: true,
      },
    });

    if (!found) return null;
    return ManuscriptHistoryMapper.toDomain(found);
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
        files: true,
        sizeBytes: true,
        createdAt: true,
        labels: true,
      },
    });

    return records
      .reverse()
      .map((r) => ManuscriptHistoryMapper.toDomainHeader(r));
  }

  public async saveLabel(label: VersionLabel): Promise<VersionLabel> {
    const snapRow = this.prisma.pageSnapshot?.findUnique
      ? await Promise.resolve(
          this.prisma.pageSnapshot.findUnique({
            where: { id: label.snapshotId },
            select: { pageId: true },
          }),
        ).catch(() => null)
      : null;
    const targetPageId =
      snapRow?.pageId ||
      (await this.resolveTargetPageId(label.projectId, label.pageId));

    const existing = await this.prisma.pageSnapshotLabel.findFirst?.({
      where: {
        spaceId: label.projectId,
        pageId: targetPageId,
        label: label.label,
      },
    });

    const saved = existing
      ? await this.prisma.pageSnapshotLabel.update({
          where: { id: existing.id },
          data: {
            snapshotId: label.snapshotId,
            version: label.version,
            label: label.label,
            updatedAt: label.updatedAt,
          },
        })
      : await this.prisma.pageSnapshotLabel.create({
          data: {
            id: label.id,
            spaceId: label.projectId,
            pageId: targetPageId,
            snapshotId: label.snapshotId,
            version: label.version,
            label: label.label,
            createdById: label.createdById,
            createdAt: label.createdAt,
            updatedAt: label.updatedAt,
          },
        });

    return ManuscriptHistoryMapper.toDomainLabel(saved);
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
        spaceId: projectId,
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
        spaceId: projectId,
        pageId: canonicalPageId,
        label,
      },
    });

    if (!found) return null;
    return ManuscriptHistoryMapper.toDomainLabel(found);
  }
}
