/**
 * project-history/core/adapters/database/manuscript-history.mapper.ts
 * Mapper transforming between Prisma persistence models and Domain entities,
 * delegating pure JSON snapshot normalization to SnapshotNormalizer.
 */

import {
  ManuscriptSnapshot as PrismaSnapshot,
  ManuscriptLabel as PrismaLabel,
} from '@prisma/client';
import { Snapshot } from '@/modules/manuscripts/project-history/core/domain/entities/snapshot.entity';
import { VersionLabel } from '@/modules/manuscripts/project-history/core/domain/entities/version-label.entity';
import { FileSnapshotVo } from '@/modules/manuscripts/project-history/core/domain/value-objects/file-snapshot.vo';
import {
  SnapshotNormalizer,
  RawSnapshotFileEntry,
} from '../../../domain/snapshot-normalizer';

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

  public static toDomainSnapshot(prisma: PrismaSnapshotWithLabels): Snapshot {
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

  public static toDomain(prisma: PrismaSnapshotWithLabels): Snapshot {
    return this.toDomainSnapshot(prisma);
  }
}
