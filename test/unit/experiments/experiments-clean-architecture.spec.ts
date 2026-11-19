import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ContentHash,
  ByteRange,
  StorageKey,
  StorageBlob,
  BlobStatus,
  StorageQuota,
} from '@/modules/files';
import { ExperimentNode, FileScope } from '@/modules/experiments';
describe('Storage Clean Architecture & DDD Domain Suite', () => {
  describe('ContentHash Value Object', () => {
    it('should compute consistent SHA-256 hash from buffer', () => {
      const payload = Buffer.from(
        'Quantum Machine Learning Research Paper 2026',
      );
      const hash1 = ContentHash.fromBuffer(payload);
      const hash2 = ContentHash.fromBuffer(payload);

      expect(hash1.toHex()).toBe(hash2.toHex());
      expect(hash1.toHex().length).toBe(64);
      expect(hash1.equals(hash2)).toBe(true);
    });

    it('should reject invalid hex strings', () => {
      expect(() => ContentHash.fromHex('invalid-hex')).toThrow();
      expect(() => ContentHash.fromHex('1234')).toThrow(); // Too short
    });
  });

  describe('ByteRange Value Object (RFC 7233)', () => {
    it('should parse standard byte range: bytes=0-499', () => {
      const range = ByteRange.parse('bytes=0-499', 1000);
      expect(range).not.toBeNull();
      expect(range?.start).toBe(0);
      expect(range?.end).toBe(499);
      expect(range?.length).toBe(500);
      expect(range?.getContentRangeHeader()).toBe('bytes 0-499/1000');
    });

    it('should parse prefix range: bytes=500-', () => {
      const range = ByteRange.parse('bytes=500-', 1000);
      expect(range?.start).toBe(500);
      expect(range?.end).toBe(999);
      expect(range?.length).toBe(500);
    });

    it('should parse suffix range: bytes=-200', () => {
      const range = ByteRange.parse('bytes=-200', 1000);
      expect(range?.start).toBe(800);
      expect(range?.end).toBe(999);
      expect(range?.length).toBe(200);
    });

    it('should reject invalid or out-of-bounds ranges', () => {
      expect(ByteRange.parse('bytes=1000-2000', 500)).toBeNull(); // Start > size
      expect(ByteRange.parse('bytes=500-200', 1000)).toBeNull(); // End < start
      expect(ByteRange.parse('invalid-range', 1000)).toBeNull();
    });
  });

  describe('StorageKey Value Object (CAS Sharding)', () => {
    it('should generate 2-level prefix sharded path for uniform S3 distribution', () => {
      const sha256 =
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const key = StorageKey.forBlob(sha256);
      expect(key.value()).toBe(`blobs/e3/b0/${sha256}`);
    });

    it('should sanitize path traversal attempts in raw keys', () => {
      const dirty = StorageKey.fromString('../../etc/passwd/key');
      expect(dirty.value()).not.toContain('..');
    });
  });

  describe('StorageBlob Entity (CAS Reference Counting)', () => {
    it('should track reference counts and readiness status', () => {
      const hash = ContentHash.fromBuffer(Buffer.from('binary-data'));
      const blob = new StorageBlob({
        id: 'blob-uuid-1',
        contentHash: hash,
        sizeBytes: 1024n,
        s3Key: StorageKey.forBlob(hash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
        refCount: 2,
      });

      expect(blob.refCount).toBe(2);
      expect(blob.status).toBe(BlobStatus.READY);
      expect(blob.isReady()).toBe(true);
    });
  });

  describe('ExperimentNode Entity (Drive Hierarchy & Invariants)', () => {
    it('should prevent circular move into itself', () => {
      const folder = new ExperimentNode({
        id: 'folder-1',
        name: 'Research Papers',
        isFolder: true,
        size: 0n,
        authorId: 'user-1',
      });

      expect(() => folder.moveTo('folder-1')).toThrow(
        'A folder cannot be moved into itself',
      );
    });

    it('should evaluate soft-delete state from trashedAt', () => {
      const activeFile = new ExperimentNode({
        id: 'file-1',
        name: 'experiment_results.csv',
        isFolder: false,
        size: 2048n,
        authorId: 'user-1',
        scope: FileScope.Project,
      });
      expect(activeFile.isTrashed()).toBe(false);

      const trashedFile = new ExperimentNode({
        id: 'file-2',
        name: 'trashed_results.csv',
        isFolder: false,
        size: 2048n,
        authorId: 'user-1',
        scope: FileScope.Project,
        trashedAt: new Date(),
      });
      expect(trashedFile.isTrashed()).toBe(true);
    });
  });

  describe('StorageQuota Entity', () => {
    it('should expose spaceId, usedBytes, and maxBytes for scope', () => {
      const quota = new StorageQuota({
        id: 'quota-1',
        spaceId: 'user-1',
        usedBytes: 1000n,
        maxBytes: 2000n,
      });

      expect(quota.spaceId).toBe('user-1');
      expect(quota.usedBytes).toBe(1000n);
      expect(quota.maxBytes).toBe(2000n);
    });
  });

  describe('Module Boundary & Zero Technical Debt Guardrails', () => {
    const collectTsFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectTsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          results.push(fullPath);
        }
      }
      return results;
    };

    const srcRoot = path.resolve(__dirname, '../../../src/modules');
    const filesDir = path.join(srcRoot, 'files');
    const experimentsDir = path.join(srcRoot, 'experiments');

    it('every .ts file in modules/files and modules/experiments has < 750 lines', () => {
      const allFiles = [
        ...collectTsFiles(filesDir),
        ...collectTsFiles(experimentsDir),
      ];
      expect(allFiles.length).toBeGreaterThan(0);

      for (const filePath of allFiles) {
        const lineCount = fs
          .readFileSync(filePath, 'utf8')
          .split(/\r?\n/).length;
        expect(lineCount).toBeLessThan(750);
      }
    });

    it('modules/files enforces strict boundaries (only controllers may import auth)', () => {
      const forbiddenDomainImport =
        /@\/modules\/(experiments|pages|library|project|ai|chat|activity|notifications|integrations|realtime)/;
      const controllersDir = path.join(filesDir, 'controllers');

      for (const filePath of collectTsFiles(filesDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(forbiddenDomainImport);
        const isController = filePath.startsWith(controllersDir + path.sep);
        if (!isController) {
          expect(content).not.toMatch(/@\/modules\//);
        } else {
          expect(content).not.toMatch(/@\/modules\/(?!identity\/auth)/);
        }
      }
    });

    it('library and work-item modules have 0 imports from modules/experiments', () => {
      const libraryDir = path.join(srcRoot, 'library');
      const workItemDir = path.join(srcRoot, 'project', 'work-item');
      for (const filePath of [
        ...collectTsFiles(libraryDir),
        ...collectTsFiles(workItemDir),
      ]) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(/@\/modules\/experiments/);
      }
    });

    it('modules/experiments has 0 legacy storage/drive symbols or runtime /api/v1/storage/files routes', () => {
      const legacySymbolRegex =
        /\b(STORAGE_PORT|IStoragePort|StorageNode|StorageVersion|DriveController|DriveService|StorageOutboxEvent|normalizeStorageProjectId|driveService)\b/;
      for (const filePath of collectTsFiles(experimentsDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(legacySymbolRegex);

        const withoutMigrationSql = content.replace(
          /export const LEGACY_URL_BACKFILL_SQL = `[\s\S]*?`;/,
          '',
        );
        expect(withoutMigrationSql).not.toContain('/api/v1/storage/files');
      }
    });

    it('modules/experiments has 0 foreign-domain leaks and 0 direct FilesModule internals', () => {
      const foreignDomainRegex =
        /\b(FileScope\.(?:Page|Library|Paper)|resolvePageSpaceId|streamR2File|pageId)\b|prisma\.page|pages\/:pageId|\/api\/v1\/experiments\/files\/r2|\bimport\s+sharp\b|from\s+['"]sharp['"]/;
      const filesInternalsRegex =
        /\b(BlobService|QuotaService|PresignService|FileStreamService|ThumbnailService|STORAGE_ADAPTER|STORAGE_BLOB_REPOSITORY|STORAGE_QUOTA_REPOSITORY|UPLOAD_SESSION_REPOSITORY|validateMagicBytes|isBlockedExtension|ByteRange|StorageKey|StorageBlob|ContentHash|UploadSession|UploadSessionStatus)\b/;

      for (const filePath of collectTsFiles(experimentsDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(foreignDomainRegex);
        expect(content).not.toMatch(filesInternalsRegex);
      }
    });

    it('no module outside modules/files uses scattered FilesModule internals or raw storage_blobs/storage_quotas access', () => {
      const scatteredInternalsRegex =
        /\b(BlobService|QuotaService|PresignService|FileStreamService|ThumbnailService|FilesLifecycleService|STORAGE_ADAPTER|STORAGE_BLOB_REPOSITORY|STORAGE_QUOTA_REPOSITORY|UPLOAD_SESSION_REPOSITORY|validateMagicBytes|isBlockedExtension)\b/;
      const rawStorageDbAccessRegex =
        /storage_blobs|storage_quotas|\.storageBlob\b|\.storageQuota\b/;

      for (const filePath of collectTsFiles(srcRoot)) {
        if (filePath.startsWith(filesDir + path.sep)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(scatteredInternalsRegex);
        expect(content).not.toMatch(rawStorageDbAccessRegex);
      }

      const filesModulePath = path.join(filesDir, 'files.module.ts');
      const filesModuleContent = fs.readFileSync(filesModulePath, 'utf8');
      expect(filesModuleContent).toContain(
        'exports: [FilesFacade, FILES_PORT]',
      );
    });

    it('modules/files enforces pure spaceId-only internal and HTTP edge contract (0 legacy quota shims or projectId)', () => {
      const legacyQuotaShimRegex =
        /\b(resolveQuotaArgs|resolveCanonicalScope|findByScope|scopeId)\b/;

      for (const filePath of collectTsFiles(filesDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(legacyQuotaShimRegex);
        expect(content).not.toMatch(/\bprojectId\b/);
      }
    });
  });
});
