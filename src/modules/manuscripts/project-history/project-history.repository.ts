/**
 * project-history/project-history.repository.ts
 * Direct Injectable Prisma Persistence Repository & Domain Mapper for Project History Snapshots & Labels.
 */

import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  Prisma,
  ManuscriptSnapshot as PrismaSnapshot,
  ManuscriptLabel as PrismaLabel,
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
  public static toDomainLabel(prisma: PrismaLabel): VersionLabel {
    return VersionLabel.create({
      id: prisma.id,
      projectId: prisma.projectId,
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
    projectId: string;
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
    return Snapshot.create({
      id: record.id,
      projectId: record.projectId,
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

  public static toDomain(prisma: PrismaSnapshotWithLabels): Snapshot {
    const filesMap = SnapshotNormalizer.parseSnapshotFiles(prisma.files);
    const labels = prisma.labels
      ? prisma.labels.map((l) => this.toDomainLabel(l))
      : [];

    return Snapshot.create({
      id: prisma.id,
      projectId: prisma.projectId,
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

  private async resolveNextVersion(
    projectId: string,
    fallbackVersion: number,
  ): Promise<number> {
    const agg = await this.prisma.manuscriptSnapshot.aggregate({
      where: { projectId },
      _max: { version: true },
    });
    return Math.max(fallbackVersion, (agg?._max?.version ?? 0) + 1);
  }

  public async saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    let candidateVersion = snapshot.version;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const filesJson = snapshot.toFilesJson() as Prisma.InputJsonValue;
        const sizeBytes = Buffer.byteLength(JSON.stringify(filesJson), 'utf8');
        const created = await this.prisma.manuscriptSnapshot.create({
          data: {
            id: snapshot.id,
            projectId: snapshot.projectId,
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
  ): Promise<Snapshot | null> {
    const found = await this.prisma.manuscriptSnapshot.findUnique({
      where: {
        projectId_version: {
          projectId,
          version,
        },
      },
      include: {
        labels: true,
      },
    });

    if (!found) return null;
    return ManuscriptHistoryMapper.toDomain(found);
  }

  public async getLatestVersion(projectId: string): Promise<number> {
    const agg = await this.prisma.manuscriptSnapshot.aggregate({
      where: { projectId },
      _max: { version: true },
    });
    if (agg?._max?.version !== undefined) {
      return agg._max.version ?? 0;
    }
    const latest = await this.prisma.manuscriptSnapshot.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return latest ? latest.version : 0;
  }

  public async listVersions(projectId: string): Promise<Snapshot[]> {
    const records = await this.prisma.manuscriptSnapshot.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
      take: 500,
      select: {
        id: true,
        projectId: true,
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
    const saved = await this.prisma.manuscriptLabel.upsert({
      where: {
        projectId_label: {
          projectId: label.projectId,
          label: label.label,
        },
      },
      create: {
        id: label.id,
        projectId: label.projectId,
        snapshotId: label.snapshotId,
        version: label.version,
        label: label.label,
        createdById: label.createdById,
        createdAt: label.createdAt,
        updatedAt: label.updatedAt,
      },
      update: {
        snapshotId: label.snapshotId,
        version: label.version,
        label: label.label,
        updatedAt: label.updatedAt,
      },
    });

    return ManuscriptHistoryMapper.toDomainLabel(saved);
  }

  public async deleteLabel(projectId: string, labelId: string): Promise<void> {
    await this.prisma.manuscriptLabel.deleteMany({
      where: {
        id: labelId,
        projectId,
      },
    });
  }

  public async findLabelByName(
    projectId: string,
    label: string,
  ): Promise<VersionLabel | null> {
    const found = await this.prisma.manuscriptLabel.findUnique({
      where: {
        projectId_label: {
          projectId,
          label,
        },
      },
    });

    if (!found) return null;
    return ManuscriptHistoryMapper.toDomainLabel(found);
  }
}
