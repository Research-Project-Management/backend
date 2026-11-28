/**
 * modules/pages/bootstrap/index.ts
 * Deep-module public entry point for Editor BFF bootstrap hydration.
 */

export type {
  BootstrapEditorParams,
  EditorBootstrapActiveDocDto,
  EditorBootstrapDegradedBranch,
  EditorBootstrapGithubLinkDto,
  EditorBootstrapLastBuildDto,
  EditorBootstrapPermissionsDto,
  EditorBootstrapResponseDto,
  EditorBootstrapTreeNodeDto,
  EditorBootstrapWorkspaceDto,
} from './editor-bootstrap.types';
export { EditorBootstrapService } from './editor-bootstrap.service';
export { EditorBootstrapModule } from './editor-bootstrap.module';
