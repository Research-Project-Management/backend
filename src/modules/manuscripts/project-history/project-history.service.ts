/**
 * project-history/project-history.service.ts
 * Deep Module Service orchestrating Manuscript Project History directly via ProjectHistoryRepository
 * and pure MyersDiffEngine, while preserving backward compatibility for legacy use-case tests.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProjectHistoryRepository } from './project-history.repository';
import {
  MyersDiffEngine,
  Snapshot,
  VersionLabel,
  VersionNotFoundException,
  DuplicateLabelException,
} from './domain';
import { ManuscriptCollectorAdapter } from './core/adapters/external/manuscript-collector.adapter';
import { ManuscriptRestorerAdapter } from './core/adapters/external/manuscript-restorer.adapter';

import { CreateSnapshotUseCase } from './core/use-cases/create-snapshot.use-case';
import { GetVersionListUseCase } from './core/use-cases/get-version-list.use-case';
import { GetSnapshotByVersionUseCase } from './core/use-cases/get-snapshot-by-version.use-case';
import { CompareVersionsDiffUseCase } from './core/use-cases/compare-versions-diff.use-case';
import { LabelVersionUseCase } from './core/use-cases/label-version.use-case';
import { DeleteLabelUseCase } from './core/use-cases/delete-label.use-case';
import { RestoreVersionUseCase } from './core/use-cases/restore-version.use-case';
import {
  CreateSnapshotDto,
  SnapshotDetailDto,
  VersionListItemDto,
  VersionLabelDto,
  DiffResponseDto,
} from './dto/history.dto';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import { ManuscriptUserResolverService } from '@/modules/manuscripts/docstore/services/manuscript-user-resolver.service';

@Injectable()
export class ProjectHistoryService {
  private readonly logger = new Logger(ProjectHistoryService.name);
  private readonly diffEngine = new MyersDiffEngine();

  constructor(
    @Optional() private readonly createSnapshotUseCase?: CreateSnapshotUseCase,
    @Optional() private readonly getVersionListUseCase?: GetVersionListUseCase,
    @Optional()
    private readonly getSnapshotByVersionUseCase?: GetSnapshotByVersionUseCase,
    @Optional()
    private readonly compareVersionsDiffUseCase?: CompareVersionsDiffUseCase,
    @Optional() private readonly labelVersionUseCase?: LabelVersionUseCase,
    @Optional() private readonly deleteLabelUseCase?: DeleteLabelUseCase,
    @Optional() private readonly restoreVersionUseCase?: RestoreVersionUseCase,
    @Optional() private readonly realtimeService?: RealtimeService,
    @Optional() private readonly userResolver?: ManuscriptUserResolverService,
    @Optional() private readonly repository?: ProjectHistoryRepository,
    @Optional() private readonly collector?: ManuscriptCollectorAdapter,
    @Optional() private readonly restorer?: ManuscriptRestorerAdapter,
  ) {}

  public async createSnapshot(
    projectId: string,
    dto: CreateSnapshotDto,
    userId?: string | null,
  ): Promise<SnapshotDetailDto> {
    const snapshot =
      this.repository && this.collector
        ? await this.createSnapshotDirect({
            projectId,
            summary: dto.summary,
            createdById: userId,
            isAutomatic: dto.isAutomatic ?? false,
            label: dto.label,
          })
        : await this.createSnapshotUseCase!.execute({
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
    const snapshots = this.repository
      ? await this.repository.listVersions(projectId)
      : await this.getVersionListUseCase!.execute(projectId);

    const authorMap = this.userResolver
      ? await this.userResolver.resolveUserNames(
          snapshots.map((s) => s.createdById),
        )
      : new Map<string, { id: string; name: string; avatar?: string }>();

    return snapshots.map((s) => {
      const author = s.createdById
        ? authorMap.get(s.createdById) || {
            id: s.createdById,
            name: 'Collaborator',
          }
        : null;
      return this.toListItemDto(s, author);
    });
  }

  public async getSnapshot(
    projectId: string,
    version: number,
  ): Promise<SnapshotDetailDto> {
    if (this.repository) {
      const found = await this.repository.findByVersion(projectId, version);
      if (!found) {
        throw new VersionNotFoundException(projectId, version);
      }
      return this.toDetailDto(found);
    }

    const snapshot = await this.getSnapshotByVersionUseCase!.execute(
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
    if (this.repository) {
      const [baseSnapshot, targetSnapshot] = await Promise.all([
        this.repository.findByVersion(projectId, baseVersion),
        this.repository.findByVersion(projectId, targetVersion),
      ]);
      if (!baseSnapshot) {
        throw new VersionNotFoundException(projectId, baseVersion);
      }
      if (!targetSnapshot) {
        throw new VersionNotFoundException(projectId, targetVersion);
      }

      const fileDiffs = this.diffEngine.compareSnapshots(
        baseSnapshot,
        targetSnapshot,
      );
      let totalAdditions = 0;
      let totalDeletions = 0;
      for (const fd of fileDiffs) {
        totalAdditions += fd.additions;
        totalDeletions += fd.deletions;
      }

      return {
        baseVersion,
        targetVersion,
        totalAdditions,
        totalDeletions,
        filesChanged: fileDiffs.length,
        files: fileDiffs,
      };
    }

    const result = await this.compareVersionsDiffUseCase!.execute(
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
    if (this.repository) {
      const cleanLabel = label.trim();
      const snapshot = await this.repository.findByVersion(projectId, version);
      if (!snapshot) {
        throw new VersionNotFoundException(projectId, version);
      }

      const existing = await this.repository.findLabelByName(
        projectId,
        cleanLabel,
      );
      if (existing && existing.version !== version) {
        throw new DuplicateLabelException(projectId, cleanLabel);
      }

      const versionLabel =
        existing ??
        VersionLabel.create({
          projectId,
          snapshotId: snapshot.id,
          version,
          label: cleanLabel,
          createdById: userId || null,
        });

      if (existing) {
        versionLabel.updateLabel(cleanLabel);
      }

      const saved = await this.repository.saveLabel(versionLabel);
      return this.toLabelDto(saved);
    }

    const versionLabel = await this.labelVersionUseCase!.execute({
      projectId,
      version,
      label,
      createdById: userId,
    });
    return this.toLabelDto(versionLabel);
  }

  public async deleteLabel(projectId: string, labelId: string): Promise<void> {
    if (this.repository) {
      await this.repository.deleteLabel(projectId, labelId);
      return;
    }
    await this.deleteLabelUseCase!.execute(projectId, labelId);
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
    if (this.repository && this.restorer && this.collector) {
      const targetSnapshot = await this.repository.findByVersion(
        projectId,
        targetVersion,
      );
      if (!targetSnapshot) {
        throw new VersionNotFoundException(projectId, targetVersion);
      }

      const restoreResult = await this.restorer.restoreToState(
        projectId,
        targetSnapshot,
      );

      const newSnapshot = await this.createSnapshotDirect({
        projectId,
        summary: `Restored to version ${targetVersion}`,
        createdById: userId || null,
        isAutomatic: false,
      });

      return {
        restoredSnapshot: this.toDetailDto(targetSnapshot),
        newSnapshot: this.toDetailDto(newSnapshot),
        restoreResult,
      };
    }

    const result = await this.restoreVersionUseCase!.execute({
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

  private async createSnapshotDirect(input: {
    projectId: string;
    summary?: string | null;
    createdById?: string | null;
    isAutomatic?: boolean;
    label?: string | null;
  }): Promise<Snapshot> {
    const {
      projectId,
      summary,
      createdById,
      isAutomatic = false,
      label,
    } = input;

    if (label && label.trim()) {
      const existingLabel = await this.repository!.findLabelByName(
        projectId,
        label.trim(),
      );
      if (existingLabel) {
        throw new DuplicateLabelException(projectId, label.trim());
      }
    }

    const latestVersion = await this.repository!.getLatestVersion(projectId);
    const nextVersion = latestVersion + 1;
    const files = await this.collector!.collectCurrentState(projectId);

    const snapshot = Snapshot.create({
      projectId,
      version: nextVersion,
      summary: summary || null,
      createdById: createdById || null,
      isAutomatic,
      files,
    });

    let versionLabel: VersionLabel | null = null;
    if (label && label.trim()) {
      versionLabel = VersionLabel.create({
        projectId,
        snapshotId: snapshot.id,
        version: nextVersion,
        label: label.trim(),
        createdById,
      });
      snapshot.addLabel(versionLabel);
    }

    const saved = await this.repository!.saveSnapshot(snapshot);
    if (versionLabel) {
      await this.repository!.saveLabel(versionLabel);
    }

    return saved;
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
      author:
        author ??
        (snapshot.createdById
          ? { id: snapshot.createdById, name: 'Collaborator' }
          : null),
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
