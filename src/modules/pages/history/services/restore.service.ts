import { Injectable, Optional, NotFoundException } from '@nestjs/common';
import { HistoryRepository } from '../history.repository';
import { SnapshotRestorerAdapter } from '../adapters/restorer.adapter';
import { VersionNotFoundException } from '../domain/errors';
import { SnapshotDetailDto } from '../dto/snapshot.dto';
import {
  RestoreSingleFileDto,
  RestoreSingleFileResponseDto,
} from '../dto/restore.dto';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { SnapshotService } from './snapshot.service';

@Injectable()
export class RestoreService {
  constructor(
    private readonly repository: HistoryRepository,
    private readonly restorer: SnapshotRestorerAdapter,
    private readonly snapshots: SnapshotService,
    @Optional() private readonly realtimeService?: RealtimeFacade,
  ) {}

  public async restoreVersion(
    projectId: string,
    targetVersion: number,
    userId?: string | null,
    pageId?: string,
  ): Promise<{
    restoredSnapshot: SnapshotDetailDto;
    newSnapshot: SnapshotDetailDto;
    restoreResult: { restoredFilesCount: number; restoredDocIds: string[] };
  }> {
    const targetSnapshot = await this.repository.findByVersion(
      projectId,
      targetVersion,
      pageId,
    );
    if (!targetSnapshot) {
      throw new VersionNotFoundException(projectId, targetVersion);
    }

    const effectivePageId = pageId ?? targetSnapshot.pageId;
    const restoreResult = await this.restorer.restoreToState(
      projectId,
      targetSnapshot,
      effectivePageId,
    );

    const newSnapshot = await this.snapshots.createSnapshotDirect({
      projectId,
      pageId: effectivePageId,
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
      restoredSnapshot: this.snapshots.toDetailDto(targetSnapshot),
      newSnapshot: this.snapshots.toDetailDto(newSnapshot),
      restoreResult,
    };
  }

  public async restoreSingleFile(
    projectId: string,
    targetVersion: number,
    dto: RestoreSingleFileDto,
    userId?: string | null,
    pageId?: string,
  ): Promise<RestoreSingleFileResponseDto> {
    const resolvedPageId = pageId ?? dto.pageId;
    const targetSnapshot = await this.repository.findByVersion(
      projectId,
      targetVersion,
      resolvedPageId,
    );
    if (!targetSnapshot) {
      throw new VersionNotFoundException(projectId, targetVersion);
    }

    if (typeof this.restorer.restoreSingleFileToState !== 'function') {
      throw new NotFoundException('Single-file restore adapter not configured');
    }

    const effectivePageId = resolvedPageId ?? targetSnapshot.pageId;
    let restoredFile;
    try {
      restoredFile = await this.restorer.restoreSingleFileToState(
        projectId,
        targetSnapshot,
        dto.pathname,
        dto.fileId,
        effectivePageId,
      );
    } catch (err: unknown) {
      if (
        err instanceof NotFoundException ||
        (err instanceof Error &&
          (err.name === 'SnapshotFileNotFoundException' ||
            err.message.toLowerCase().includes('not found')))
      ) {
        throw new NotFoundException(
          err.message ||
            `File ${dto.pathname} not found in version ${targetVersion}`,
        );
      }
      throw err;
    }

    const newSnapshot = await this.snapshots.createSnapshotDirect({
      projectId,
      pageId: effectivePageId,
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
}
