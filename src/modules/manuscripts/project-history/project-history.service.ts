/**
 * project-history/project-history.service.ts
 * Deep Module Service orchestrating Manuscript Project History directly via ProjectHistoryRepository
 * and pure MyersDiffEngine.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ProjectHistoryRepository,
  ManuscriptCollectorAdapter,
  ManuscriptRestorerAdapter,
} from './project-history.repository';
import {
  MyersDiffEngine,
  Snapshot,
  VersionLabel,
  VersionNotFoundException,
  DuplicateLabelException,
} from './domain';
import {
  CreateSnapshotDto,
  SnapshotDetailDto,
  VersionListItemDto,
  VersionLabelDto,
  DiffResponseDto,
} from './dto/history.dto';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { ManuscriptUserResolverService } from '@/modules/manuscripts/docstore/services/manuscript-user-resolver.service';

@Injectable()
export class ProjectHistoryService {
  private readonly logger = new Logger(ProjectHistoryService.name);
  private readonly diffEngine = new MyersDiffEngine();

  constructor(
    private readonly repository: ProjectHistoryRepository,
    private readonly collector: ManuscriptCollectorAdapter,
    private readonly restorer: ManuscriptRestorerAdapter,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly userResolver?: ManuscriptUserResolverService,
  ) {}

  public async createSnapshot(
    projectId: string,
    dto: CreateSnapshotDto,
    userId?: string | null,
  ): Promise<SnapshotDetailDto> {
    const snapshot = await this.createSnapshotDirect({
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
    const snapshots = await this.repository.listVersions(projectId);

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
    const found = await this.repository.findByVersion(projectId, version);
    if (!found) {
      throw new VersionNotFoundException(projectId, version);
    }
    return this.toDetailDto(found);
  }

  public async compareVersions(
    projectId: string,
    baseVersion: number,
    targetVersion: number,
  ): Promise<DiffResponseDto> {
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

  public async labelVersion(
    projectId: string,
    version: number,
    label: string,
    userId?: string | null,
  ): Promise<VersionLabelDto> {
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

  public async deleteLabel(projectId: string, labelId: string): Promise<void> {
    await this.repository.deleteLabel(projectId, labelId);
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
      const existingLabel = await this.repository.findLabelByName(
        projectId,
        label.trim(),
      );
      if (existingLabel) {
        throw new DuplicateLabelException(projectId, label.trim());
      }
    }

    const latestVersion = await this.repository.getLatestVersion(projectId);
    const nextVersion = latestVersion + 1;
    const files = await this.collector.collectCurrentState(projectId);

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

    const saved = await this.repository.saveSnapshot(snapshot);
    if (versionLabel) {
      await this.repository.saveLabel(versionLabel);
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
