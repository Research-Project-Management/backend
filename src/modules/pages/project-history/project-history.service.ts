/**
 * project-history/project-history.service.ts
 * Deep Module Service orchestrating Manuscript Project History directly via ProjectHistoryRepository
 * and pure DiffEngine.
 */

import {
  Injectable,
  Logger,
  Optional,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { ProjectHistoryRepository } from './project-history.repository';
import {
  ManuscriptCollectorAdapter,
  ManuscriptRestorerAdapter,
} from './adapters/project-history.adapters';
import {
  Snapshot,
  VersionLabel,
  VersionNotFoundException,
  DuplicateLabelException,
  DiffEngine,
} from './domain';
import {
  CreateSnapshotDto,
  SnapshotDetailDto,
  VersionListItemDto,
  VersionLabelDto,
  DiffResponseDto,
  RestoreSingleFileDto,
  RestoreSingleFileResponseDto,
} from './dto/history.dto';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';

@Injectable()
export class ProjectHistoryService {
  private readonly logger = new Logger(ProjectHistoryService.name);
  private readonly diffEngine: DiffEngine;

  constructor(
    private readonly repository: ProjectHistoryRepository,
    private readonly collector: ManuscriptCollectorAdapter,
    private readonly restorer: ManuscriptRestorerAdapter,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly userResolver?: UserResolverService,
    @Optional() diffEngine?: DiffEngine,
  ) {
    this.diffEngine = diffEngine ?? new DiffEngine();
  }

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
    const [snapshot, existing] = await Promise.all([
      this.repository.findByVersion(projectId, version),
      this.repository.findLabelByName(projectId, cleanLabel),
    ]);
    if (!snapshot) {
      throw new VersionNotFoundException(projectId, version);
    }

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

    this.realtimeService?.broadcastSnapshotCreated(projectId, {
      version: newSnapshot.version,
      summary: newSnapshot.summary,
      label: null,
    });

    return {
      restoredSnapshot: this.toDetailDto(targetSnapshot),
      newSnapshot: this.toDetailDto(newSnapshot),
      restoreResult,
    };
  }

  public async restoreSingleFile(
    projectId: string,
    targetVersion: number,
    dto: RestoreSingleFileDto,
    userId?: string | null,
  ): Promise<RestoreSingleFileResponseDto> {
    const targetSnapshot = await this.repository.findByVersion(
      projectId,
      targetVersion,
    );
    if (!targetSnapshot) {
      throw new VersionNotFoundException(projectId, targetVersion);
    }

    if (typeof this.restorer.restoreSingleFileToState !== 'function') {
      throw new NotFoundException('Single-file restore adapter not configured');
    }

    let restoredFile;
    try {
      restoredFile = await this.restorer.restoreSingleFileToState(
        projectId,
        targetSnapshot,
        dto.pathname,
        dto.fileId,
      );
    } catch (err: unknown) {
      throw new NotFoundException(
        (err as Error)?.message ||
          `File ${dto.pathname} not found in version ${targetVersion}`,
      );
    }

    const newSnapshot = await this.createSnapshotDirect({
      projectId,
      summary: `Restored ${dto.pathname} from Version ${targetVersion}`,
      createdById: userId || null,
      isAutomatic: false,
    });

    this.realtimeService?.broadcastSnapshotCreated(projectId, {
      version: newSnapshot.version,
      summary: newSnapshot.summary,
      label: null,
    });

    return {
      path: restoredFile.path,
      version: targetVersion,
      newVersion: newSnapshot.version,
      docId: restoredFile.docId ?? null,
      fileId: restoredFile.fileId ?? null,
      content: restoredFile.content,
      rev: restoredFile.rev,
    };
  }

  public async exportVersionZipStream(
    projectId: string,
    version: number,
    projectName?: string,
  ): Promise<{
    zipStream: Readable;
    filename: string;
    fileCount: number;
  }> {
    const snapshot = await this.repository.findByVersion(projectId, version);
    if (!snapshot) {
      throw new VersionNotFoundException(projectId, version);
    }

    const { zipStream, fileCount } = this.collector.createSnapshotZipStream(
      projectId,
      snapshot,
    );

    const baseName =
      (projectName || 'manuscript')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '_') || 'manuscript';
    const labelSuffix =
      snapshot.labels && snapshot.labels.length > 0
        ? `-${snapshot.labels[0].label.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')}`
        : `-v${version}`;
    const filename = `${baseName}${labelSuffix}.zip`;

    return {
      zipStream,
      filename,
      fileCount,
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

    const files = await this.collector.collectCurrentState(projectId);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const latestVersion = await this.repository.getLatestVersion(projectId);
      const nextVersion = latestVersion + 1;

      const snapshot = Snapshot.create({
        projectId,
        version: nextVersion,
        summary: summary || null,
        createdById: createdById || null,
        isAutomatic,
        files,
      });

      try {
        const saved = await this.repository.saveSnapshot(snapshot);
        if (label && label.trim()) {
          const versionLabel = VersionLabel.create({
            projectId,
            snapshotId: saved.id,
            version: saved.version,
            label: label.trim(),
            createdById,
          });
          await this.repository.saveLabel(versionLabel);
          saved.addLabel(versionLabel);
        }
        return saved;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'P2002' && attempt < maxAttempts - 1) {
          continue;
        }
        throw err;
      }
    }

    throw new ConflictException(
      `Failed to create snapshot for project ${projectId} after ${maxAttempts} attempts`,
    );
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
