/**
 * modules/manuscripts/clsi/core/ports/workspace.port.ts
 * Contract for managing project scratch workspaces with Overleaf's incremental hashing
 */

import type { WorkspaceFile } from '../../domain/workspace-file.interface';
export type { WorkspaceFile };

export interface WorkspaceSyncStats {
  written: number;
  unchanged: number;
  deleted: number;
}

export interface AuxFileInfo {
  name: string;
  size: number;
  ext: string;
}

export interface IWorkspaceManager {
  ensureScratch(projectId: string): Promise<string>;
  getScratchDir(projectId: string): string;
  syncFiles(
    projectId: string,
    files: WorkspaceFile[],
  ): Promise<WorkspaceSyncStats>;
  cleanScratch(projectId: string): Promise<void>;
  purgeExtraneousFiles(projectId: string, inputFiles: string[]): Promise<void>;
  listAuxFiles(projectId: string): Promise<AuxFileInfo[]>;
  readAuxFile(projectId: string, filename: string): Promise<Buffer | null>;
  readArtifact(projectId: string, filename: string): Promise<Buffer | null>;
}
