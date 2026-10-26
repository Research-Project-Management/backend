/**
 * modules/manuscripts/clsi/domain/safe-path.ts
 * Path Traversal Guard preventing directory traversal, prefix collisions,
 * and symlink breakouts.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { UnsafePathException } from './sandbox-errors';

export class SafePath {
  /**
   * Sanitizes and validates a relative path.
   * Rejects absolute paths, UNC paths, drive letters, null bytes, and traversal beyond root.
   */
  public static sanitizeRelativePath(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') {
      throw new UnsafePathException(
        'Invalid file path: path must be a non-empty string',
      );
    }

    if (filePath.includes('\0')) {
      throw new UnsafePathException('Invalid file path: null byte detected');
    }

    // Reject Windows UNC paths or drive letters before normalization
    if (/^[a-zA-Z]:/.test(filePath) || filePath.startsWith('\\\\')) {
      throw new UnsafePathException(
        `Security Violation: Absolute paths are not allowed (${filePath})`,
      );
    }

    const normalized = path.normalize(filePath).replace(/\\/g, '/');

    if (
      path.isAbsolute(normalized) ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw new UnsafePathException(
        `Security Violation: Absolute paths are not allowed (${filePath})`,
      );
    }

    if (
      normalized.startsWith('../') ||
      normalized === '..' ||
      normalized.includes('/../')
    ) {
      throw new UnsafePathException(
        `Security Violation: Path traversal detected in ${filePath}`,
      );
    }

    return normalized;
  }

  /**
   * Resolves a relative path against baseDir, ensuring strict containment
   * and preventing prefix collisions (e.g. /base vs /base-evil).
   */
  public static resolveSafePath(baseDir: string, relativePath: string): string {
    const sanitized = this.sanitizeRelativePath(relativePath);
    const resolvedBase = path.resolve(baseDir);
    const resolved = path.resolve(resolvedBase, sanitized);

    const baseWithSep = resolvedBase.endsWith(path.sep)
      ? resolvedBase
      : resolvedBase + path.sep;

    if (resolved !== resolvedBase && !resolved.startsWith(baseWithSep)) {
      throw new UnsafePathException(
        `Security Violation: Target path is outside base directory (${relativePath})`,
      );
    }

    return resolved;
  }

  /**
   * Asynchronously validates that the target path and all existing ancestor directories
   * resolve within the real physical path of baseDir (preventing symlink breakout).
   */
  public static async assertSafeWorkspacePath(
    baseDir: string,
    relativePath: string,
  ): Promise<string> {
    const resolvedTarget = this.resolveSafePath(baseDir, relativePath);
    const resolvedBase = path.resolve(baseDir);

    let realBase: string;
    try {
      realBase = await fs.realpath(baseDir);
    } catch {
      // If baseDir does not exist yet, resolveSafePath is sufficient
      return resolvedTarget;
    }

    const realBaseWithSep = realBase.endsWith(path.sep)
      ? realBase
      : realBase + path.sep;

    // Check if the target itself exists and is a symlink or resolves outside
    try {
      const realTarget = await fs.realpath(resolvedTarget);
      if (realTarget !== realBase && !realTarget.startsWith(realBaseWithSep)) {
        throw new UnsafePathException(
          `Security Violation: Symlink points outside workspace (${relativePath})`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof UnsafePathException) throw err;
      // Target does not exist yet, check deepest existing ancestor
      let currentDir = path.dirname(resolvedTarget);
      while (currentDir.length >= resolvedBase.length) {
        try {
          const realAncestor = await fs.realpath(currentDir);
          if (
            realAncestor !== realBase &&
            !realAncestor.startsWith(realBaseWithSep)
          ) {
            throw new UnsafePathException(
              `Security Violation: Directory symlink points outside workspace (${relativePath})`,
            );
          }
          break;
        } catch {
          const parent = path.dirname(currentDir);
          if (parent === currentDir) break;
          currentDir = parent;
        }
      }
    }

    return resolvedTarget;
  }
}
