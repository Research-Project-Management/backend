import { ContentHash } from '@/modules/storage/domain/value-objects/content-hash.vo';
import { ByteRange } from '@/modules/storage/domain/value-objects/byte-range.vo';
import { StorageKey } from '@/modules/storage/domain/value-objects/storage-key.vo';
import {
  StorageBlob,
  BlobStatus,
} from '@/modules/storage/domain/entities/storage-blob.entity';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { StorageQuota } from '@/modules/storage/domain/entities/storage-quota.entity';
import { FileScope } from '@/modules/storage/domain/value-objects/file-scope.vo';

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
    it('should manage reference counts and tombstone transition', () => {
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

      // 1st deletion: still referenced
      const isEligible1 = blob.decrementRef();
      expect(isEligible1).toBe(false);
      expect(blob.refCount).toBe(1);
      expect(blob.status).toBe(BlobStatus.READY);

      // 2nd deletion: refCount = 0 -> marks DELETED with tombstone
      const isEligible2 = blob.decrementRef(48);
      expect(isEligible2).toBe(true);
      expect(blob.refCount).toBe(0);
      expect(blob.status).toBe(BlobStatus.DELETED);
      expect(blob.tombstoneAt).toBeInstanceOf(Date);

      // Re-upload of same content resurrects the blob
      blob.incrementRef();
      expect(blob.refCount).toBe(1);
      expect(blob.status).toBe(BlobStatus.READY);
      expect(blob.tombstoneAt).toBeNull();
    });
  });

  describe('StorageNode Entity (Drive Hierarchy & Invariants)', () => {
    it('should prevent circular move into itself', () => {
      const folder = new StorageNode({
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

    it('should manage soft-delete and restore states', () => {
      const file = new StorageNode({
        id: 'file-1',
        name: 'experiment_results.csv',
        isFolder: false,
        size: 2048n,
        authorId: 'user-1',
        scope: FileScope.Project,
      });

      expect(file.isTrashed()).toBe(false);

      file.trash();
      expect(file.isTrashed()).toBe(true);
      expect(file.trashedAt).toBeInstanceOf(Date);

      file.restore();
      expect(file.isTrashed()).toBe(false);
      expect(file.trashedAt).toBeNull();
    });
  });

  describe('StorageQuota Entity (Capacity & Limit Enforcement)', () => {
    it('should correctly evaluate available capacity and consume bytes', () => {
      const quota = new StorageQuota({
        id: 'quota-1',
        userId: 'user-1',
        usedBytes: 1000n,
        maxBytes: 2000n,
      });

      expect(quota.hasCapacity(500n)).toBe(true);
      expect(quota.hasCapacity(1500n)).toBe(false);

      quota.consume(500n);
      expect(quota.usedBytes).toBe(1500n);
      expect(quota.getUsagePercentage()).toBe(75);

      expect(() => quota.consume(1000n)).toThrow('Storage quota exceeded');
    });

    it('should safely release quota bytes without going below zero', () => {
      const quota = new StorageQuota({
        id: 'quota-1',
        userId: 'user-1',
        usedBytes: 500n,
        maxBytes: 1000n,
      });

      quota.release(300n);
      expect(quota.usedBytes).toBe(200n);

      quota.release(500n); // Release more than used
      expect(quota.usedBytes).toBe(0n);
    });
  });
});
