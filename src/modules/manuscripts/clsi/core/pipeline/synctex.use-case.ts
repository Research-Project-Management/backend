/**
 * modules/manuscripts/clsi/core/pipeline/synctex.use-case.ts
 * Use case resolving forward & reverse SyncTeX queries for a project
 */

import { IWorkspaceManager } from '../ports/workspace.port';
import {
  ISyncTexProcessor,
  SyncPoint,
  ReverseSyncPoint,
} from '../ports/artifacts.port';

export interface ForwardSyncRequest {
  projectId?: string;
  file: string;
  line: number;
  column?: number;
  synctex?: string;
}

export interface ReverseSyncRequest {
  projectId?: string;
  page: number;
  x: number;
  y: number;
  synctex?: string;
}

export class SyncTexUseCase {
  constructor(
    private readonly workspace: IWorkspaceManager,
    private readonly processor: ISyncTexProcessor
  ) {}

  private async getSynctexText(
    projectId: string,
    providedSynctex?: string
  ): Promise<string> {
    if (providedSynctex) {
      const buffer = Buffer.from(providedSynctex, 'base64');
      return this.processor.decompress(buffer);
    }

    const gzBuffer = await this.workspace.readArtifact(
      projectId,
      'output.synctex.gz'
    );
    if (gzBuffer) {
      return this.processor.decompress(gzBuffer);
    }

    const plainBuffer = await this.workspace.readArtifact(
      projectId,
      'output.synctex'
    );
    if (plainBuffer) {
      return plainBuffer.toString('utf8');
    }

    return '';
  }

  public async forwardSync(dto: ForwardSyncRequest): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  }> {
    const projectId = dto.projectId || 'default';
    const synctexText = await this.getSynctexText(projectId, dto.synctex);

    if (!synctexText) {
      return {
        success: false,
        error: 'SyncTeX data not available. Please compile the document first.',
      };
    }

    const result = this.processor.forwardLookup(
      synctexText,
      dto.file,
      dto.line,
      dto.column
    );

    if (!result) {
      return {
        success: false,
        error: `Could not map line ${dto.line} to PDF coordinates`,
      };
    }

    return { success: true, result };
  }

  public async reverseSync(dto: ReverseSyncRequest): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  }> {
    const projectId = dto.projectId || 'default';
    const synctexText = await this.getSynctexText(projectId, dto.synctex);

    if (!synctexText) {
      return {
        success: false,
        error: 'SyncTeX data not available. Please compile the document first.',
      };
    }

    const result = this.processor.reverseLookup(
      synctexText,
      dto.page,
      dto.x,
      dto.y
    );

    if (!result) {
      return {
        success: false,
        error: `Could not map PDF coordinates on page ${dto.page} to LaTeX source`,
      };
    }

    return { success: true, result };
  }
}
