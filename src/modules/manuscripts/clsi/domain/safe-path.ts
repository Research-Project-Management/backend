/**
 * modules/manuscripts/clsi/domain/safe-path.ts
 * Path Traversal Guard to prevent directory traversal attacks (e.g. ../../etc/passwd)
 */

import * as path from 'path';

export class SafePath {
  public static sanitizeRelativePath(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path: path must be a non-empty string');
    }

    if (filePath.includes('\0')) {
      throw new Error('Invalid file path: null byte detected');
    }

    const normalized = path.normalize(filePath).replace(/\\/g, '/');

    if (
      path.isAbsolute(normalized) ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw new Error(
        `Security Violation: Absolute paths are not allowed (${filePath})`,
      );
    }

    if (
      normalized.startsWith('../') ||
      normalized === '..' ||
      normalized.includes('/../')
    ) {
      throw new Error(
        `Security Violation: Path traversal detected in ${filePath}`,
      );
    }

    return normalized;
  }

  public static resolveSafePath(baseDir: string, relativePath: string): string {
    const sanitized = this.sanitizeRelativePath(relativePath);
    const resolved = path.resolve(baseDir, sanitized);
    const resolvedBase = path.resolve(baseDir);

    if (!resolved.startsWith(resolvedBase)) {
      throw new Error(
        `Security Violation: Target path is outside base directory (${relativePath})`,
      );
    }

    return resolved;
  }
}

/** Backwards compatibility alias */
export const SafePathUtil = SafePath;
