/**
 * test/unit/manuscripts/clsi/safe-path.spec.ts
 * Verifies that SafePath prevents directory traversal, prefix collisions,
 * absolute paths, UNC paths, and symlink breakouts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SafePath } from '../../../../src/modules/manuscripts/clsi/domain/safe-path';
import { UnsafePathException } from '../../../../src/modules/manuscripts/clsi/domain/sandbox.errors';

describe('SafePath Traversal & Prefix Collision Hardening (Slice S5 / US4)', () => {
  let tmpBaseDir: string;

  beforeAll(async () => {
    tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-path-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('sanitizeRelativePath', () => {
    it('should accept clean relative paths', () => {
      expect(SafePath.sanitizeRelativePath('main.tex')).toBe('main.tex');
      expect(SafePath.sanitizeRelativePath('chapters/intro.tex')).toBe('chapters/intro.tex');
      expect(SafePath.sanitizeRelativePath('images/fig1.png')).toBe('images/fig1.png');
    });

    it('should normalize Windows backslashes to forward slashes', () => {
      expect(SafePath.sanitizeRelativePath('sections\\section1.tex')).toBe('sections/section1.tex');
    });

    it('should throw UnsafePathException on null bytes', () => {
      expect(() => SafePath.sanitizeRelativePath('main.tex\0.png')).toThrow(UnsafePathException);
    });

    it('should throw UnsafePathException on absolute paths', () => {
      expect(() => SafePath.sanitizeRelativePath('/etc/passwd')).toThrow(UnsafePathException);
      expect(() => SafePath.sanitizeRelativePath('C:\\Windows\\System32')).toThrow(UnsafePathException);
      expect(() => SafePath.sanitizeRelativePath('\\\\server\\share\\file.tex')).toThrow(UnsafePathException);
    });

    it('should throw UnsafePathException on path traversal (..)', () => {
      expect(() => SafePath.sanitizeRelativePath('../secret.txt')).toThrow(UnsafePathException);
      expect(() => SafePath.sanitizeRelativePath('dir/../../secret.txt')).toThrow(UnsafePathException);
      expect(() => SafePath.sanitizeRelativePath('dir/subdir/../../..')).toThrow(UnsafePathException);
      expect(SafePath.sanitizeRelativePath('foo/bar/..')).toBe('foo');
    });
  });

  describe('resolveSafePath', () => {
    it('should resolve safe path within baseDir', () => {
      const resolved = SafePath.resolveSafePath(tmpBaseDir, 'main.tex');
      expect(resolved).toBe(path.join(tmpBaseDir, 'main.tex'));
    });

    it('should prevent prefix collisions (e.g. /scratch/proj vs /scratch/proj-evil)', () => {
      const base = path.join(tmpBaseDir, 'proj');
      const evilTarget = path.join(tmpBaseDir, 'proj-evil', 'malicious.tex');

      // Attempting to resolve relative traversal that lands in a directory sharing a prefix
      expect(() => SafePath.resolveSafePath(base, '../proj-evil/malicious.tex')).toThrow(
        UnsafePathException,
      );
    });
  });

  describe('assertSafeWorkspacePath (async symlink verification)', () => {
    it('should allow valid files inside base directory', async () => {
      const testFile = path.join(tmpBaseDir, 'valid.tex');
      await fs.writeFile(testFile, 'hello');

      const resolved = await SafePath.assertSafeWorkspacePath(tmpBaseDir, 'valid.tex');
      expect(resolved).toBe(path.resolve(testFile));
    });

    it('should reject symlinks that point outside the base directory', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-target-'));
      const secretFile = path.join(outsideDir, 'secret.env');
      await fs.writeFile(secretFile, 'SECRET=123');

      const symlinkFile = path.join(tmpBaseDir, 'leaked-symlink.tex');

      try {
        await fs.symlink(secretFile, symlinkFile);
        await expect(
          SafePath.assertSafeWorkspacePath(tmpBaseDir, 'leaked-symlink.tex'),
        ).rejects.toThrow(UnsafePathException);
      } catch (err: unknown) {
        // On Windows without Developer Mode, symlink creation might fail with EPERM.
        // If symlink cannot be created, skip symlink assertion.
        if ((err as { code?: string })?.code !== 'EPERM') {
          throw err;
        }
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});
