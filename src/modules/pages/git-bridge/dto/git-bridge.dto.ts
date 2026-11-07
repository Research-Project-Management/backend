/**
 * git-bridge/dto/git-bridge.dto.ts
 * DTO contracts for Git Bridge token management and repository info.
 */

export class CreateGitTokenDto {
  label?: string;
}

export interface GitTokenSummaryDto {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface GitRepoInfoResponseDto {
  enabled: boolean;
  cloneUrl: string;
  branch: string;
  canPush: boolean;
  tokens: GitTokenSummaryDto[];
}
