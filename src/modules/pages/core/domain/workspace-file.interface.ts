/**
 * modules/manuscripts/core/domain/workspace-file.interface.ts
 * Shared Kernel contract representing a file in the manuscript compiler/project workspace.
 */

export interface WorkspaceFile {
  path: string;
  content: string | Buffer;
  hash?: string;
}

export interface CompilationPayload {
  rootDocPath: string;
  files: WorkspaceFile[];
}
