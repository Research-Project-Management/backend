/**
 * project-history/project-history.service.ts
 * Main Injectable Service orchestrating Manuscript Project History use cases.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { CreateSnapshotUseCase } from './core/use-cases/create-snapshot.use-case';
import { GetVersionListUseCase } from './core/use-cases/get-version-list.use-case';
import { GetSnapshotByVersionUseCase } from './core/use-cases/get-snapshot-by-version.use-case';
import { CompareVersionsDiffUseCase } from './core/use-cases/compare-versions-diff.use-case';
import { LabelVersionUseCase } from './core/use-cases/label-version.use-case';
import { DeleteLabelUseCase } from './core/use-cases/delete-label.use-case';
import { RestoreVersionUseCase } from './core/use-cases/restore-version.use-case';
import { Snapshot } from './core/domain/entities/snapshot.entity';
import { VersionLabel } from './core/domain/entities/version-label.entity';
import {
  CreateSnapshotDto,
  SnapshotDetailDto,
  VersionListItemDto,
  VersionLabelDto,
  DiffResponseDto,
} from './dto/history.dto';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import { PrismaService } from '@/core';

@Injectable()
export class ProjectHistoryService {
  private readonly logger = new Logger(ProjectHistoryService.name);

  constructor(
    private readonly createSnapshotUseCase: CreateSnapshotUseCase,
    private readonly getVersionListUseCase: GetVersionListUseCase,
    private readonly getSnapshotByVersionUseCase: GetSnapshotByVersionUseCase,
    private readonly compareVersionsDiffUseCase: CompareVersionsDiffUseCase,
    private readonly labelVersionUseCase: LabelVersionUseCase,
    private readonly deleteLabelUseCase: DeleteLabelUseCase,
    private readonly restoreVersionUseCase: RestoreVersionUseCase,
    @Optional() private readonly realtimeService?: RealtimeService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  public async createSnapshot(
    projectId: string,
    dto: CreateSnapshotDto,
    userId?: string | null,
  ): Promise<SnapshotDetailDto> {
    const snapshot = await this.createSnapshotUseCase.execute({
      projectId,
      summary: dto.summary,
      createdById: userId,
      isAutomatic: dto.isAutomatic ?? false,
      label: dto.label,
    });
    this.realtimeService?.broadcastSnapshotCreated(projectId, {
      version: snapshot.version,
      summary: snapshot.summary,
      label:
        dto.label ||
        (snapshot.labels.length > 0 ? snapshot.labels[0].label : null),
    });
    return this.toDetailDto(snapshot);
  }

  public async listVersions(projectId: string): Promise<VersionListItemDto[]> {
    const snapshots = await this.getVersionListUseCase.execute(projectId);

    const authorMap = new Map<string, { id: string; name: string; avatar?: string }>();
    if (this.prisma) {
      const userIds = Array.from(
        new Set(
          snapshots
            .map((s) => s.createdById)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        )
      );
      if (userIds.length > 0) {
        try {
          const users = await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              profile: {
                select: {
                  name: true,
                  avatar: true,
                },
              },
            },
          });
          for (const u of users) {
            authorMap.set(u.id, {
              id: u.id,
              name: u.profile?.name || 'Collaborator',
              avatar: u.profile?.avatar || undefined,
            });
          }
        } catch (err) {
          this.logger.debug(`Failed to fetch author metadata for history: ${err}`);
        }
      }
    }

    return snapshots.map((s) => {
      const author = s.createdById
        ? authorMap.get(s.createdById) || { id: s.createdById, name: 'Collaborator' }
        : null;
      return this.toListItemDto(s, author);
    });
  }

  public async getSnapshot(
    projectId: string,
    version: number,
  ): Promise<SnapshotDetailDto> {
    const snapshot = await this.getSnapshotByVersionUseCase.execute(
      projectId,
      version,
    );
    return this.toDetailDto(snapshot);
  }

  public async compareVersions(
    projectId: string,
    baseVersion: number,
    targetVersion: number,
  ): Promise<DiffResponseDto> {
    const result = await this.compareVersionsDiffUseCase.execute(
      projectId,
      baseVersion,
      targetVersion,
    );
    return {
      baseVersion: result.baseVersion,
      targetVersion: result.targetVersion,
      totalAdditions: result.totalAdditions,
      totalDeletions: result.totalDeletions,
      filesChanged: result.filesChanged,
      files: result.files,
    };
  }

  public async labelVersion(
    projectId: string,
    version: number,
    label: string,
    userId?: string | null,
  ): Promise<VersionLabelDto> {
    const versionLabel = await this.labelVersionUseCase.execute({
      projectId,
      version,
      label,
      createdById: userId,
    });
    return this.toLabelDto(versionLabel);
  }

  public async deleteLabel(projectId: string, labelId: string): Promise<void> {
    await this.deleteLabelUseCase.execute(projectId, labelId);
  }

  public async restoreVersion(
    projectId: string,
    targetVersion: number,
    userId?: string | null,
  ): Promise<{
    restoredSnapshot: SnapshotDetailDto;
    newSnapshot: SnapshotDetailDto;
    restoreResult: { restoredFilesCount: number; restoredDocIds: string[] };
  }> {
    const result = await this.restoreVersionUseCase.execute({
      projectId,
      targetVersion,
      userId,
    });

    return {
      restoredSnapshot: this.toDetailDto(result.targetSnapshot),
      newSnapshot: this.toDetailDto(result.newSnapshot),
      restoreResult: result.restoreResult,
    };
  }

  public toLabelDto(label: VersionLabel): VersionLabelDto {
    return {
      id: label.id,
      version: label.version,
      label: label.label,
      createdById: label.createdById,
      createdAt: label.createdAt,
    };
  }

  public toListItemDto(
    snapshot: Snapshot,
    author?: { id: string; name: string; avatar?: string } | null,
  ): VersionListItemDto {
    return {
      id: snapshot.id,
      projectId: snapshot.projectId,
      version: snapshot.version,
      summary: snapshot.summary,
      createdById: snapshot.createdById,
      author: author ?? (snapshot.createdById ? { id: snapshot.createdById, name: 'Collaborator' } : null),
      isAutomatic: snapshot.isAutomatic,
      fileCount: snapshot.fileCount,
      labels: snapshot.labels.map((l) => this.toLabelDto(l)),
      createdAt: snapshot.createdAt,
    };
  }

  public toDetailDto(snapshot: Snapshot): SnapshotDetailDto {
    return {
      ...this.toListItemDto(snapshot),
      files: snapshot.toFilesJson(),
    };
  }
}
