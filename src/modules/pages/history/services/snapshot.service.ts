import {
  Injectable,
  Optional,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { HistoryRepository } from '../history.repository';
import { SnapshotCollectorAdapter } from '../adapters/snapshot-collector.adapter';
import { Snapshot } from '../domain/snapshot.entity';
import { VersionLabel } from '../domain/label.entity';
import {
  VersionNotFoundException,
  DuplicateLabelException,
} from '../domain/errors';
import {
  CreateSnapshotDto,
  SnapshotDetailDto,
  VersionListItemDto,
  VersionLabelDto,
} from '../dto/history.dto';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';

@Injectable()
export class SnapshotService {
  constructor(
    private readonly repository: HistoryRepository,
    private readonly collector: SnapshotCollectorAdapter,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly userResolver?: UserResolverService,
  ) {}

  public async createSnapshot(
    projectId: string,
    dto: CreateSnapshotDto,
    userId?: string | null,
    pageId?: string,
  ): Promise<SnapshotDetailDto> {
    const resolvedPageId = pageId ?? dto.pageId;
    const snapshot = await this.createSnapshotDirect({
      projectId,
      pageId: resolvedPageId,
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

  public async listVersions(
    projectId: string,
    pageId?: string,
  ): Promise<VersionListItemDto[]> {
    const snapshots = await this.repository.listVersions(projectId, pageId);

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
    pageId?: string,
  ): Promise<SnapshotDetailDto> {
    const found = await this.repository.findByVersion(
      projectId,
      version,
      pageId,
    );
    if (!found) {
      throw new VersionNotFoundException(projectId, version);
    }
    return this.toDetailDto(found);
  }

  public async getBlob(
    spaceId: string,
    contentHash: string,
  ): Promise<{
    contentHash: string;
    content: string | null;
    sizeBytes: number;
    inStorage: boolean;
    storageKey: string | null;
  }> {
    const blob = await this.repository.findBlobInSpace(spaceId, contentHash);
    if (!blob) {
      throw new NotFoundException(
        `History blob '${contentHash}' was not found in space '${spaceId}'.`,
      );
    }
    return blob;
  }

  public async flushHistory(
    spaceId: string,
    userId?: string | null,
    pageId?: string,
  ): Promise<{ flushed: boolean; snapshot: SnapshotDetailDto | null }> {
    const currentFiles = await this.collector.collectCurrentState(
      spaceId,
      pageId,
    );
    if (currentFiles.size === 0) {
      return { flushed: false, snapshot: null };
    }

    const latestVersion = await this.repository.getLatestVersion(
      spaceId,
      pageId,
    );
    if (latestVersion > 0) {
      const latestSnap = await this.repository.findByVersion(
        spaceId,
        latestVersion,
        pageId,
      );
      if (latestSnap && latestSnap.files.size === currentFiles.size) {
        let identical = true;
        for (const [pathname, vo] of currentFiles.entries()) {
          const prev = latestSnap.files.get(pathname);
          if (!prev || prev.hash !== vo.hash) {
            identical = false;
            break;
          }
        }
        if (identical) {
          return { flushed: false, snapshot: null };
        }
      }
    }

    const created = await this.createSnapshot(
      spaceId,
      { summary: 'Auto-saved history checkpoint', isAutomatic: true, pageId },
      userId,
      pageId,
    );
    return { flushed: true, snapshot: created };
  }

  public async compactAndGc(
    spaceId?: string,
    olderThanDays = 30,
  ): Promise<{ compactedSnapshots: number; deletedOrphanBlobs: number }> {
    const compactedSnapshots = await this.repository.compactAutoSnapshots(
      spaceId,
      olderThanDays,
    );
    const deletedOrphanBlobs = await this.repository.gcOrphanBlobs();
    return { compactedSnapshots, deletedOrphanBlobs };
  }

  public async exportVersionZipStream(
    projectId: string,
    version: number,
    projectName?: string,
    pageId?: string,
  ): Promise<{
    zipStream: Readable;
    filename: string;
    fileCount: number;
  }> {
    const snapshot = await this.repository.findByVersion(
      projectId,
      version,
      pageId,
    );
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
        ? `-${snapshot.labels[0].label
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/\s+/g, '_')}`
        : `-v${version}`;

    return {
      zipStream,
      filename: `${baseName}${labelSuffix}.zip`,
      fileCount,
    };
  }

  public async createSnapshotDirect(input: {
    projectId: string;
    pageId?: string;
    summary?: string | null;
    createdById?: string | null;
    isAutomatic?: boolean;
    label?: string | null;
  }): Promise<Snapshot> {
    const {
      projectId,
      pageId,
      summary,
      createdById,
      isAutomatic = false,
      label,
    } = input;

    if (label && label.trim()) {
      const existingLabel = await this.repository.findLabelByName(
        projectId,
        label.trim(),
        pageId,
      );
      if (existingLabel) {
        throw new DuplicateLabelException(projectId, label.trim());
      }
    }

    const files = await this.collector.collectCurrentState(projectId, pageId);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const latestVersion = await this.repository.getLatestVersion(
        projectId,
        pageId,
      );
      const snapshot = Snapshot.create({
        projectId,
        spaceId: projectId,
        pageId,
        version: latestVersion + 1,
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
            spaceId: projectId,
            pageId: saved.pageId ?? pageId,
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

  public toListItemDto(
    snapshot: Snapshot,
    author?: { id: string; name: string; avatar?: string } | null,
  ): VersionListItemDto {
    return {
      id: snapshot.id,
      projectId: snapshot.projectId,
      spaceId: snapshot.spaceId,
      pageId: snapshot.pageId,
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
      labels: snapshot.labels.map(
        (l): VersionLabelDto => ({
          id: l.id,
          version: l.version,
          label: l.label,
          createdById: l.createdById,
          createdAt: l.createdAt,
        }),
      ),
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
