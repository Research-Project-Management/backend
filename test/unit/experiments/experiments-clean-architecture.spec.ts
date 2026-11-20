import * as fs from 'node:fs';
import * as path from 'node:path';
import { BlobStatus, StorageBlobRecord } from '@/modules/files';
import {
  ContentHash,
  ByteRange,
  StorageKey,
} from '@/modules/files/domain/storage-vo';
import {
  ExperimentNode,
  FileScope,
} from '@/modules/experiments/domain/node.domain';
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

  describe('StorageBlobRecord Plain Shape (CAS Readiness)', () => {
    it('tracks reference counts and readiness status without anemic class wrappers', () => {
      const hash = ContentHash.fromBuffer(Buffer.from('binary-data'));
      const blob: StorageBlobRecord = {
        id: 'blob-uuid-1',
        contentHashHex: hash.toHex(),
        hashAlgorithm: 'SHA256',
        sizeBytes: 1024n,
        mimeType: 'application/octet-stream',
        checksumVerified: true,
        s3Key: StorageKey.forBlob(hash.toHex()).value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.READY,
        refCount: 2,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      };

      expect(blob.refCount).toBe(2);
      expect(blob.status).toBe(BlobStatus.READY);
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
        /@\/modules\/(experiments|pages|library|project|ai|chat|activity|integrations|realtime)/;
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
        expect(content).not.toContain('/api/v1/storage/files');
      }
    });

    it('modules/experiments has 0 foreign-domain leaks and 0 direct FilesModule internals', () => {
      const foreignDomainRegex =
        /\b(FileScope\.(?:Page|Library|Paper)|resolvePageSpaceId|streamR2File|pageId)\b|prisma\.page|pages\/:pageId|\/api\/v1\/experiments\/files\/r2|\bimport\s+sharp\b|from\s+['"]sharp['"]/;
      const filesInternalsRegex =
        /\b(BlobService|FilesUploadService|PresignService|ThumbnailService|FileAccessService|BlobRepository|QuotaRepository|SessionRepository|QuotaService|FileStreamService|FilesLifecycleService|STORAGE_ADAPTER|STORAGE_BLOB_REPOSITORY|STORAGE_QUOTA_REPOSITORY|UPLOAD_SESSION_REPOSITORY|validateMagicBytes|isBlockedExtension|ByteRange|StorageKey|ContentHash)\b/;

      for (const filePath of collectTsFiles(experimentsDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(foreignDomainRegex);
        expect(content).not.toMatch(filesInternalsRegex);
      }
    });

    it('no module outside modules/files uses scattered FilesModule internals or raw file_blobs/space_quotas access', () => {
      const scatteredInternalsRegex =
        /\b(BlobService|FilesUploadService|PresignService|ThumbnailService|FileAccessService|BlobRepository|QuotaRepository|SessionRepository|FilesMaintenanceProcessor|QuotaService|FileStreamService|FilesLifecycleService|STORAGE_ADAPTER|STORAGE_BLOB_REPOSITORY|STORAGE_QUOTA_REPOSITORY|UPLOAD_SESSION_REPOSITORY|validateMagicBytes|isBlockedExtension)\b/;
      const rawStorageDbAccessRegex =
        /file_blobs|file_blob_refs|file_uploads|space_quotas|storage_blobs|storage_quotas|\.fileBlob\b|\.fileBlobRef\b|\.fileUpload\b|\.spaceQuota\b|\.storageBlob\b|\.storageQuota\b/;

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

      const filesIndexContent = fs.readFileSync(
        path.join(filesDir, 'index.ts'),
        'utf8',
      );
      expect(filesIndexContent).not.toMatch(
        /\.\/(services|repositories|adapters|processors|controllers)\//,
      );
      expect(filesIndexContent).not.toMatch(/\bSTORAGE_ADAPTER\b/);
    });

    it('modules/files has zero eliminated middlemen, Prisma-in-service leaks, or controller bypasses', () => {
      const deletedMiddlemenRegex =
        /\b(PresignService|QuotaService|FileStreamService|FilesLifecycleService|FilesSpaceAccessService|FileSigningService|BlobMapper|QuotaMapper|SessionMapper|STORAGE_BLOB_REPOSITORY|STORAGE_QUOTA_REPOSITORY|STORAGE_BLOB_REF_REPOSITORY|UPLOAD_SESSION_REPOSITORY)\b/;

      const repoDir = path.join(filesDir, 'repositories');
      for (const filePath of collectTsFiles(filesDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(deletedMiddlemenRegex);
        if (!filePath.startsWith(repoDir + path.sep)) {
          expect(content).not.toMatch(/\bPrismaService\b/);
        }
      }

      const controllerSrc = fs.readFileSync(
        path.join(filesDir, 'controllers', 'files.controller.ts'),
        'utf8',
      );
      expect(controllerSrc).not.toMatch(
        /\b(FileAccessService|BlobService|FilesUploadService|BlobRepository|QuotaRepository|SessionRepository|STORAGE_ADAPTER)\b/,
      );

      const blobServiceSrc = fs.readFileSync(
        path.join(filesDir, 'services', 'blob.service.ts'),
        'utf8',
      );
      expect(blobServiceSrc).not.toMatch(
        /\b(findBlobById|findBlobByHash|acquireBlob|releaseBlob|hasSpaceAccessToBlob|incrementBlobRef)\s*\(/,
      );

      const sessionRepoSrc = fs.readFileSync(
        path.join(filesDir, 'repositories', 'session.repository.ts'),
        'utf8',
      );
      expect(sessionRepoSrc).not.toMatch(/Personal|Project/);
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

    it('FilesModule keeps deep facade encapsulation (no BlobService in FilesController, zero process.env in BlobService, zero duplicate IFilesPort aliases)', () => {
      const filesControllerPath = path.join(
        filesDir,
        'controllers',
        'files.controller.ts',
      );
      const controllerSrc = fs.readFileSync(filesControllerPath, 'utf8');
      expect(controllerSrc).not.toMatch(/\bBlobService\b/);

      const blobServicePath = path.join(
        filesDir,
        'services',
        'blob.service.ts',
      );
      const blobServiceSrc = fs.readFileSync(blobServicePath, 'utf8');
      expect(blobServiceSrc).not.toMatch(/process\.env\./);

      const filesTypePath = path.join(filesDir, 'types', 'files.type.ts');
      const filesTypeSrc = fs.readFileSync(filesTypePath, 'utf8');
      expect(filesTypeSrc).not.toMatch(
        /\b(getPresignedUploadUrl|initiateMultipartUpload|completeMultipartUpload|abortMultipartUpload|presignMultipartPart|uploadBuffer)\b/,
      );
    });

    it('modules/experiments enforces zero PrismaService outside repositories, zero @Global, strict exports, and zero eliminated wrappers', () => {
      const repoDir = path.join(experimentsDir, 'repositories');
      const eliminatedRegex =
        /\b(EXPERIMENT_NODE_REPOSITORY|EXPERIMENT_VERSION_REPOSITORY|LEGACY_URL_BACKFILL_SQL|ExperimentsLifecycleService|TrashRetentionJob|MultipartService)\b/;

      for (const filePath of collectTsFiles(experimentsDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(eliminatedRegex);
        if (!filePath.startsWith(repoDir + path.sep)) {
          expect(content).not.toMatch(/\bPrismaService\b/);
        }
      }

      const expModuleSrc = fs.readFileSync(
        path.join(experimentsDir, 'experiments.module.ts'),
        'utf8',
      );
      expect(expModuleSrc).not.toMatch(/@Global\s*\(/);
      expect(expModuleSrc).toContain(
        'exports: [ExperimentsFacade, EXPERIMENTS_PORT]',
      );

      const expIndexSrc = fs.readFileSync(
        path.join(experimentsDir, 'index.ts'),
        'utf8',
      );
      expect(expIndexSrc).not.toMatch(
        /\.\/(services|repositories|processors|controllers|dto)\//,
      );
    });
  });
});
