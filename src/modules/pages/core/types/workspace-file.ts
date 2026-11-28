/**
 * modules/pages/core/types/workspace-file.ts
 * Shared Kernel contract representing a file in the compiler/page workspace.
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
