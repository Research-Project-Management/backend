/**
 * modules/manuscripts/clsi/domain/workspace-file.interface.ts
 * Core workspace file contract representing files in compiler workspace.
 */

export interface WorkspaceFile {
  path: string;
  content: string | Buffer;
  hash?: string;
}
