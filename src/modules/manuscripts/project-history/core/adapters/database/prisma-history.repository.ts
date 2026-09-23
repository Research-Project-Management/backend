/**
 * project-history/core/adapters/database/prisma-history.repository.ts
 * Driven Adapter implementing IHistoryRepositoryPort with PostgreSQL through Prisma.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IHistoryRepositoryPort } from '../../ports/history-repository.port';
import { Snapshot } from '../../domain/entities/snapshot.entity';
import { VersionLabel } from '../../domain/entities/version-label.entity';
import { ManuscriptHistoryMapper, PrismaSnapshotWithLabels } from './manuscript-history.mapper';

@Injectable()
export class PrismaHistoryRepository extends IHistoryRepositoryPort {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  public async saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    const created = await this.prisma.manuscriptSnapshot.upsert({
      where: {
        projectId_version: {
          projectId: snapshot.projectId,
          version: snapshot.version,
        },
      },
      create: {
        id: snapshot.id,
        projectId: snapshot.projectId,
        version: snapshot.version,
        summary: snapshot.summary,
        createdById: snapshot.createdById,
        isAutomatic: snapshot.isAutomatic,
        files: snapshot.toFilesJson(),
        createdAt: snapshot.createdAt,
      },
      update: {
        summary: snapshot.summary,
        files: snapshot.toFilesJson(),
      },
      include: {
        labels: true,
      },
    });

    return ManuscriptHistoryMapper.toDomainSnapshot(created as PrismaSnapshotWithLabels);
  }

  public async findByVersion(projectId: string, version: number): Promise<Snapshot | null> {
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
    return ManuscriptHistoryMapper.toDomainSnapshot(found as PrismaSnapshotWithLabels);
  }

  public async getLatestVersion(projectId: string): Promise<number> {
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
      orderBy: { version: 'asc' },
      include: {
        labels: true,
      },
    });

    return records.map((r) => ManuscriptHistoryMapper.toDomainSnapshot(r as PrismaSnapshotWithLabels));
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

  public async findLabelByName(projectId: string, label: string): Promise<VersionLabel | null> {
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
