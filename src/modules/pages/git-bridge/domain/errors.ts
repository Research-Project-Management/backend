/**
 * git-bridge/domain/errors.ts
 * Domain error hierarchy for Git Bridge (zero framework imports).
 */

import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class GitBridgeError extends PagesDomainError {
  constructor(message: string, code = 'GIT_BRIDGE_ERROR', statusCode = 400) {
    super(message, { code, statusCode });
  }
}

export class PushRejectedError extends GitBridgeError {
  constructor(
    public readonly reason: string,
    statusCode = 422,
  ) {
    super(reason, 'GIT_PUSH_REJECTED', statusCode);
  }
}

export class QuotaExceededError extends GitBridgeError {
  constructor(message: string) {
    super(message, 'GIT_QUOTA_EXCEEDED', 413);
  }
}

export class TokenLimitError extends GitBridgeError {
  constructor(limit: number) {
    super(
      `Maximum of ${limit} active Git tokens reached. Revoke an unused token first.`,
      'GIT_TOKEN_LIMIT',
      400,
    );
  }
}

export class LfsUnsupportedError extends GitBridgeError {
  constructor(repoPath?: string) {
    super(
      repoPath
        ? `Git LFS pointer detected at "${repoPath}". Commit raw files (< 50 MB) without Git LFS.`
        : 'Git LFS is not supported. Commit raw files (< 50 MB) without Git LFS.',
      'GIT_LFS_UNSUPPORTED',
      422,
    );
  }
}
