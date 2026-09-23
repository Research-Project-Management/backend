/**
 * project-history/core/adapters/database/manuscript-history.mapper.ts
 * Mapper transforming between Prisma persistence models and Domain entities.
 */

import {
  ManuscriptSnapshot as PrismaSnapshot,
  ManuscriptLabel as PrismaLabel,
} from '@prisma/client';
import { Snapshot } from '../../domain/entities/snapshot.entity';
import { VersionLabel } from '../../domain/entities/version-label.entity';
import { FileSnapshotVo } from '../../domain/value-objects/file-snapshot.vo';

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

  public static toDomainSnapshot(prisma: PrismaSnapshotWithLabels): Snapshot {
    const rawFiles = prisma.files as Record<string, any>;
    const filesMap = new Map<string, FileSnapshotVo>();

    if (rawFiles && typeof rawFiles === 'object') {
      for (const [path, data] of Object.entries(rawFiles)) {
        filesMap.set(path, FileSnapshotVo.fromProps(data));
      }
    }

    const labels = prisma.labels ? prisma.labels.map(this.toDomainLabel) : [];

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
