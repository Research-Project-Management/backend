/**
 * modules/pages/clsi/adapters/clsi-runtime.adapter.ts
 * Unified execution seam for Local vs Remote CLSI routing.
 * Encapsulates Remote-first compilation (with Circuit Breaker + local fallback),
 * SyncTeX remote forwarding, artifact read/list fallback, scratch cleanup, and health probing.
 */

import { Injectable } from '@nestjs/common';
import { AuxFileInfo, ReverseSyncPoint, SyncPoint } from '../domain/ports';
import { CompilePageDto } from '../dto/compile.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { ClsiRepository } from '../clsi.repository';
import {
  CompilePipelineResult,
  CompileService,
  enrichUnreachableRemoteFailure,
} from '../services/compile.service';
import { ClsiHealthCheck, type ClsiHealthReport } from './health.adapter';
import { RemoteClsiClientAdapter } from './remote-clsi.adapter';

export interface ClsiRuntimeCompileParams {
  spaceId: string;
  targetPageId?: string;
  scratchWorkspaceId: string;
  mainFile: string;
  source: string;
  mergedFiles: Record<string, string | Buffer>;
  dto: CompilePageDto;
  engine?: string;
  texLiveVersion: string;
  effectiveTimeoutMs: number;
  cacheKey: string;
  signal: AbortSignal;
  onLogChunk: (chunk: string) => void;
}

export type ClsiHealthReportWithRemote = ClsiHealthReport & {
  remote?: {
    url: string | null;
    reachable: boolean;
  };
};

@Injectable()
export class ClsiRuntimeAdapter {
  constructor(
    private readonly workspace: ClsiRepository,
    private readonly pipeline: CompileService,
    private readonly healthCheck: ClsiHealthCheck,
    private readonly remoteClient: RemoteClsiClientAdapter,
  ) {}

  public isRemoteEnabled(): boolean {
    return this.remoteClient.isEnabled();
  }

  public async compile(
    params: ClsiRuntimeCompileParams,
  ): Promise<CompilePipelineResult> {
    const {
      spaceId,
      targetPageId,
      scratchWorkspaceId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      texLiveVersion,
      effectiveTimeoutMs,
      cacheKey,
      signal,
      onLogChunk,
    } = params;

    const remoteResult = await this.remoteClient.tryRemoteClsiCompile({
      spaceId,
      pageId: targetPageId ?? scratchWorkspaceId,
      mainFile,
      source,
      mergedFiles,
      dto,
      engine,
      effectiveTimeoutMs,
      cacheKey,
      signal,
    });

    if (remoteResult) {
      await this.workspace.writeCachedArtifacts(
        scratchWorkspaceId,
        remoteResult,
      );
      return remoteResult;
    }

    const localResult = await this.pipeline.execute({
      spaceId: scratchWorkspaceId,
      mainFile,
      engine,
      texLiveVersion,
      draft: dto.draft,
      syntaxOnly: dto.syntaxOnly,
      stopOnFirstError: dto.stopOnFirstError ?? false,
      timeoutMs: effectiveTimeoutMs,
      source,
      files: mergedFiles,
      signal,
      onLogChunk,
    });

    if (this.remoteClient.isEnabled()) {
      return enrichUnreachableRemoteFailure({
        pipelineResult: localResult,
        mainFile,
        remoteUrl: this.remoteClient.getBaseUrl(),
      });
    }

    return localResult;
  }

  public async tryRemoteForwardSync(
    dto: ForwardSyncDto,
    scope: { spaceId: string; pageId?: string },
  ): Promise<{ success: boolean; result?: SyncPoint; error?: string } | null> {
    return this.remoteClient.tryRemoteForwardSync(dto, scope);
  }

  public async tryRemoteReverseSync(
    dto: ReverseSyncDto,
    scope: { spaceId: string; pageId?: string },
  ): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  } | null> {
    return this.remoteClient.tryRemoteReverseSync(dto, scope);
  }

  public async listAuxFiles(scratchId: string): Promise<AuxFileInfo[]> {
    let files = await this.workspace.listAuxFiles(scratchId);
    if (files.length === 0 && this.remoteClient.isEnabled()) {
      files = (await this.remoteClient.tryRemoteListAuxFiles(scratchId)) ?? [];
    }
    return files;
  }

  public async readAuxFile(
    scratchId: string,
    filename: string,
    allowRemoteFallback = false,
  ): Promise<Buffer | null> {
    let buffer = await this.workspace.readAuxFile(scratchId, filename);
    if (!buffer && allowRemoteFallback && this.remoteClient.isEnabled()) {
      buffer = await this.remoteClient.tryRemoteDownloadArtifact(
        scratchId,
        filename,
      );
    }
    return buffer;
  }

  public async cleanScratch(
    scratchId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.all([
      this.pipeline.runWithWorkspaceLock(
        scratchId,
        () => this.workspace.cleanScratch(scratchId),
        signal,
      ),
      this.remoteClient.isEnabled()
        ? this.remoteClient.tryRemoteCleanScratch(scratchId).catch(() => false)
        : Promise.resolve(false),
    ]);
  }

  public async getHealthReport(): Promise<ClsiHealthReportWithRemote> {
    if (this.remoteClient.isEnabled()) {
      const remoteHealth = await this.remoteClient.tryRemoteHealthCheck();
      if (remoteHealth !== null) {
        return {
          ...remoteHealth,
          remote: {
            url: this.remoteClient.getBaseUrl(),
            reachable: true,
          },
        };
      }
      const localReport = await this.healthCheck.checkHealth();
      return {
        ...localReport,
        remote: {
          url: this.remoteClient.getBaseUrl(),
          reachable: false,
        },
      };
    }
    return this.healthCheck.checkHealth();
  }
}
