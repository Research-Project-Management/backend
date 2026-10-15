/**
 * git-bridge/core/ports/git-access-repository.port.ts
 * Driven port for Git access token persistence and user/project role resolution.
 */

import {
  ProjectRole,
  StoredGitToken,
} from '@/modules/manuscripts/git-bridge/core/domain/git-bridge.domain';

export const GIT_ACCESS_REPOSITORY_PORT = Symbol('GIT_ACCESS_REPOSITORY_PORT');

export interface UserEditorGitConfig {
  editorConfig: Record<string, unknown>;
  tokens: StoredGitToken[];
}

export interface IGitAccessRepositoryPort {
  readConfig(userId: string): Promise<UserEditorGitConfig>;
  writeTokens(
    userId: string,
    editorConfig: Record<string, unknown>,
    tokens: StoredGitToken[],
  ): Promise<void>;
  isActiveUser(userId: string): Promise<boolean>;
  resolveProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null>;
}
