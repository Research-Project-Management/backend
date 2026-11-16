/**
 * modules/pages/bootstrap/editor-bootstrap.types.ts
 * Screen-driven 3-block BFF response contracts for Editor initial hydration.
 */

import type { CompilerDiagnostic } from '@/modules/pages/clsi/domain/clsi.ports';
import type { EditorLastBuildSummary } from '@/modules/pages/clsi/services/clsi.service';
import type { ProjectSymbolsResponseDto } from '@/modules/pages/structure/structure.service';

export type EditorBootstrapDegradedBranch = 'symbols' | 'lastBuild';

export interface EditorBootstrapGithubLinkDto {
  id: string;
  repoFullName: string;
  branch: string;
  lastSyncedAt: string | null;
}

export interface EditorBootstrapPermissionsDto {
  role: string;
  canEdit: boolean;
  canCompile: boolean;
}

export interface EditorBootstrapWorkspaceDto {
  spaceId: string;
  pageId: string;
  rootDocId: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  mainFilePath: string;
  permissions: EditorBootstrapPermissionsDto;
  githubLink: EditorBootstrapGithubLinkDto | null;
}

export interface EditorBootstrapTreeNodeDto {
  id: string;
  projectId: string;
  pageId: string | null;
  parentId: string | null;
  type: 'FOLDER' | 'DOC' | 'FILE';
  name: string;
  path: string;
  depth: number;
  docId?: string | null;
  fileId?: string | null;
  isRootDoc: boolean;
  sizeBytes: number;
  hash?: string | null;
  sortOrder: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  children?: EditorBootstrapTreeNodeDto[];
}

export interface EditorBootstrapActiveDocDto {
  id: string;
  nodeId: string | null;
  page: {
    id: string;
    title: string;
    content: string;
    path?: string;
    status: string;
    projectId: string;
    mainFile: { id: string; title: string };
    mainFileId: string;
    rootPageId: string;
    version: number;
    rev: number;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
  lines: string[];
  version: number;
  rev: number;
  ranges: Record<string, unknown>;
  fallbackToRoot: boolean;
}

export type EditorBootstrapLastBuildDto = EditorLastBuildSummary & {
  diagnostics: CompilerDiagnostic[];
};

export interface EditorBootstrapResponseDto {
  workspace: EditorBootstrapWorkspaceDto;
  tree: EditorBootstrapTreeNodeDto[];
  activeDoc: EditorBootstrapActiveDocDto;
  symbols: ProjectSymbolsResponseDto | null;
  lastBuild: EditorBootstrapLastBuildDto;
  degraded: boolean;
  degradedBranches: EditorBootstrapDegradedBranch[];
  serverTimestamp: string;
}

export interface BootstrapEditorParams {
  pageOrProjectId: string;
  userId: string;
  requestedFileId?: string;
  authorizedProjectId?: string | { id?: string } | null;
  role?: string | null;
  softBranchDeadlineMs?: number;
}
