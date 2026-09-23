/**
 * test/unit/manuscripts-filestore.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Filestore Subsystem (Binary Assets & Media Management Engine).
 * Validates Overleaf-parity architectures:
 *  1. Value Objects: ContentHash (SHA-1 / SHA-256), StorageKey (Prefix Partitioning), ByteRange (RFC 7233).
 *  2. Domain Entity: ManuscriptFile (Invariants, filename sanitization, max file size guards).
 *  3. Adapters:
 *      - CryptoGitBlobHasherAdapter: Git-compatible CAS (`blob ${len}\0` + SHA-1/256), stream spooling & replay.
 *      - LocalDiskBinaryStorageAdapter: Atomic write, byte-range read slice, zero-RAM streams.
 *  4. Use Cases:
 *      - UploadManuscriptFileUseCase: CAS hashing, deduplication detection, storage delegation.
 *      - StreamManuscriptFileUseCase: 200 Full Stream vs 206 Partial Content range slicing, 416 guards.
 *      - GetManuscriptFileHeadUseCase & DeleteManuscriptFileUseCase & GetSignedDownloadUrlUseCase.
 *  5. FilestoreService (Façade): openReadStream (CLSI direct feed), uploadFileFromBuffer, uploadFileFromStream.
 *  6. FilestoreController: Fastify multipart vs raw streams, Mobile Safari HTML XSS defense, Content-Disposition.
 */

import { Readable, PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { FilestoreController } from '@/modules/manuscripts/filestore/filestore.controller';
import { UploadManuscriptFileUseCase } from '@/modules/manuscripts/filestore/core/use-cases/upload-manuscript-file.use-case';
import { StreamManuscriptFileUseCase } from '@/modules/manuscripts/filestore/core/use-cases/stream-manuscript-file.use-case';
import { GetManuscriptFileHeadUseCase } from '@/modules/manuscripts/filestore/core/use-cases/get-manuscript-file-head.use-case';
import { DeleteManuscriptFileUseCase } from '@/modules/manuscripts/filestore/core/use-cases/delete-manuscript-file.use-case';
import { GetSignedDownloadUrlUseCase } from '@/modules/manuscripts/filestore/core/use-cases/get-signed-download-url.use-case';
import { IBinaryStoragePort } from '@/modules/manuscripts/filestore/core/ports/binary-storage.port';
import { IManuscriptFileRepository } from '@/modules/manuscripts/filestore/core/ports/manuscript-file-repository.port';
import { IContentHasherPort } from '@/modules/manuscripts/filestore/core/ports/content-hasher.port';
import { CryptoGitBlobHasherAdapter } from '@/modules/manuscripts/filestore/core/adapters/engine/crypto-git-blob-hasher.adapter';
import { LocalDiskBinaryStorageAdapter } from '@/modules/manuscripts/filestore/core/adapters/storage/local-disk-binary-storage.adapter';
import { ContentHash } from '@/modules/manuscripts/filestore/core/domain/value-objects/content-hash.vo';
import { StorageKey } from '@/modules/manuscripts/filestore/core/domain/value-objects/storage-key.vo';
import { ByteRange } from '@/modules/manuscripts/filestore/core/domain/value-objects/byte-range.vo';
import { ManuscriptFile, MAX_FILE_SIZE_BYTES } from '@/modules/manuscripts/filestore/core/domain/entities/manuscript-file.entity';
import { FileNotFoundException } from '@/modules/manuscripts/filestore/core/domain/exceptions/file-not-found.exception';
import { InvalidByteRangeException } from '@/modules/manuscripts/filestore/core/domain/exceptions/invalid-byte-range.exception';
import { StorageQuotaExceededException } from '@/modules/manuscripts/filestore/core/domain/exceptions/storage-quota-exceeded.exception';

// Helper to convert readable stream to buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * In-Memory Test Double for IManuscriptFileRepository
 */
class InMemoryManuscriptFileRepository implements IManuscriptFileRepository {
  public files = new Map<string, ManuscriptFile>();

  public clear() {
    this.files.clear();
  }

  public async save(file: ManuscriptFile): Promise<ManuscriptFile> {
    this.files.set(file.id, file);
    return file;
  }

  public async findById(id: string): Promise<ManuscriptFile | null> {
    return this.files.get(id) ?? null;
  }

  public async findByProjectAndId(projectId: string, id: string): Promise<ManuscriptFile | null> {
    const f = this.files.get(id);
    if (!f || f.projectId !== projectId) return null;
    return f;
  }

  public async findByProjectAndName(projectId: string, name: string): Promise<ManuscriptFile | null> {
    for (const f of this.files.values()) {
      if (f.projectId === projectId && f.name === name && !f.deleted) {
        return f;
      }
    }
    return null;
  }

  public async findByHash(hash: string): Promise<ManuscriptFile[]> {
    const results: ManuscriptFile[] = [];
    for (const f of this.files.values()) {
      if (f.hash.getValue() === hash && !f.deleted) {
        results.push(f);
      }
    }
    return results;
  }

  public async listByProject(projectId: string, includeDeleted = false): Promise<ManuscriptFile[]> {
    return Array.from(this.files.values()).filter(
      (f) => f.projectId === projectId && (includeDeleted || !f.deleted),
    );
  }

  public async delete(id: string): Promise<void> {
    this.files.delete(id);
  }

  public async countReferencesByHash(hash: string): Promise<number> {
    let count = 0;
    for (const f of this.files.values()) {
      if (f.hash.getValue() === hash && !f.deleted) {
        count++;
      }
    }
    return count;
  }
}

describe('Manuscripts - Filestore Subsystem (Overleaf Parity & CAS)', () => {
  const PROJECT_ID = 'b7d5a570-3d7c-482a-9e53-488b0a996df1';
  const BUCKET = 'manuscript-files';
  let tempStorageDir: string;
  let inMemoryRepo: InMemoryManuscriptFileRepository;
  let hasher: IContentHasherPort;
  let localStorage: IBinaryStoragePort;

  let uploadUseCase: UploadManuscriptFileUseCase;
  let streamUseCase: StreamManuscriptFileUseCase;
  let headUseCase: GetManuscriptFileHeadUseCase;
  let deleteUseCase: DeleteManuscriptFileUseCase;
  let signedUrlUseCase: GetSignedDownloadUrlUseCase;
  let filestoreService: FilestoreService;
  let filestoreController: FilestoreController;

  beforeAll(async () => {
    tempStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filestore-test-'));
  });

  afterAll(async () => {
    try {
      await fs.rm(tempStorageDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  beforeEach(async () => {
    inMemoryRepo = new InMemoryManuscriptFileRepository();
    hasher = new CryptoGitBlobHasherAdapter();
    localStorage = new LocalDiskBinaryStorageAdapter(tempStorageDir);

    uploadUseCase = new UploadManuscriptFileUseCase(localStorage, inMemoryRepo, hasher);
    streamUseCase = new StreamManuscriptFileUseCase(localStorage, inMemoryRepo);
    headUseCase = new GetManuscriptFileHeadUseCase(localStorage, inMemoryRepo);
    deleteUseCase = new DeleteManuscriptFileUseCase(localStorage, inMemoryRepo);
    signedUrlUseCase = new GetSignedDownloadUrlUseCase(localStorage, inMemoryRepo);

    filestoreService = new FilestoreService(
      uploadUseCase,
      streamUseCase,
      headUseCase,
      deleteUseCase,
      signedUrlUseCase,
      inMemoryRepo,
    );

    filestoreController = new FilestoreController(
      uploadUseCase,
      streamUseCase,
      headUseCase,
      deleteUseCase,
      signedUrlUseCase,
    );
  });

  // =========================================================================
  // 1. VALUE OBJECTS
  // =========================================================================
  describe('Value Objects', () => {
    describe('ContentHash', () => {
      it('should accept valid 40-char SHA-1 hex hash', () => {
        const validSha1 = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
        const vo = ContentHash.create(validSha1);
        expect(vo.getValue()).toBe(validSha1);
        expect(vo.toString()).toBe(validSha1);
      });

      it('should accept valid 64-char SHA-256 hex hash', () => {
        const validSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        const vo = ContentHash.create(validSha256);
        expect(vo.getValue()).toBe(validSha256);
      });

      it('should normalize uppercase hex to lowercase', () => {
        const upper = 'E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391';
        const vo = ContentHash.create(upper);
        expect(vo.getValue()).toBe(upper.toLowerCase());
      });

      it('should throw error for invalid hash strings', () => {
        expect(() => ContentHash.create('invalid-hash')).toThrow(
          'Invalid content hash format',
        );
        expect(() => ContentHash.create('')).toThrow();
        expect(() => ContentHash.create('123456')).toThrow();
      });

      it('should correctly compare two ContentHash objects', () => {
        const h1 = ContentHash.create('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
        const h2 = ContentHash.create('E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391');
        const h3 = ContentHash.create('da39a3ee5e6b4b0d3255bfef95601890afd80709');

        expect(h1.equals(h2)).toBe(true);
        expect(h1.equals(h3)).toBe(false);
      });
    });

    describe('StorageKey', () => {
      it('should create prefix-partitioned key from hash (Overleaf CAS pattern)', () => {
        const hashStr = 'abcdef0123456789abcdef0123456789abcdef01';
        const hashVo = ContentHash.create(hashStr);
        const keyVo = StorageKey.fromHash(hashVo, 'blobs');
        // blobs/ab/cd/ef0123456789abcdef0123456789abcdef01
        expect(keyVo.getValue()).toBe(`blobs/ab/cd/${hashStr.slice(4)}`);
      });

      it('should prevent directory traversal in raw keys', () => {
        expect(() => StorageKey.fromRawKey('../etc/passwd')).toThrow('Insecure storage key');
        expect(() => StorageKey.fromRawKey('/absolute/path')).toThrow('Insecure storage key');
        expect(() => StorageKey.fromRawKey('')).toThrow('cannot be empty');
      });
    });

    describe('ByteRange (RFC 7233)', () => {
      const FILE_SIZE = 1000;

      it('should parse standard byte range: bytes=0-499', () => {
        const range = ByteRange.parse('bytes=0-499', FILE_SIZE);
        expect(range).not.toBeNull();
        expect(range?.start).toBe(0);
        expect(range?.end).toBe(499);
        expect(range?.contentLength).toBe(500);
        expect(range?.toContentRangeHeader()).toBe('bytes 0-499/1000');
      });

      it('should parse open-ended suffix: bytes=500-', () => {
        const range = ByteRange.parse('bytes=500-', FILE_SIZE);
        expect(range).not.toBeNull();
        expect(range?.start).toBe(500);
        expect(range?.end).toBe(999);
        expect(range?.contentLength).toBe(500);
        expect(range?.toContentRangeHeader()).toBe('bytes 500-999/1000');
      });

      it('should parse suffix byte range: bytes=-200 (last 200 bytes)', () => {
        const range = ByteRange.parse('bytes=-200', FILE_SIZE);
        expect(range).not.toBeNull();
        expect(range?.start).toBe(800);
        expect(range?.end).toBe(999);
        expect(range?.contentLength).toBe(200);
        expect(range?.toContentRangeHeader()).toBe('bytes 800-999/1000');
      });

      it('should clamp end byte to file size - 1 if requested range exceeds file size', () => {
        const range = ByteRange.parse('bytes=500-5000', FILE_SIZE);
        expect(range).not.toBeNull();
        expect(range?.start).toBe(500);
        expect(range?.end).toBe(999);
        expect(range?.contentLength).toBe(500);
      });

      it('should return null for undefined or missing range header', () => {
        expect(ByteRange.parse(undefined, FILE_SIZE)).toBeNull();
        expect(ByteRange.parse('', FILE_SIZE)).toBeNull();
      });

      it('should throw InvalidByteRangeException for malformed or unsatisfiable range (RFC 7233 / 416)', () => {
        // start > end
        expect(() => ByteRange.parse('bytes=500-200', FILE_SIZE)).toThrow(
          InvalidByteRangeException,
        );
        // start >= file size
        expect(() => ByteRange.parse('bytes=1000-1500', FILE_SIZE)).toThrow(
          InvalidByteRangeException,
        );
        // empty file with range request
        expect(() => ByteRange.parse('bytes=0-10', 0)).toThrow(
          InvalidByteRangeException,
        );
      });
    });
  });

  // =========================================================================
  // 2. DOMAIN ENTITY (ManuscriptFile)
  // =========================================================================
  describe('ManuscriptFile Entity', () => {
    const validHash = ContentHash.create('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');

    it('should create valid ManuscriptFile entity and sanitize filename', () => {
      const file = ManuscriptFile.create({
        projectId: PROJECT_ID,
        name: '../../../etc/passwd/malicious.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        hash: validHash,
      });

      expect(file.id).toBeDefined();
      expect(file.projectId).toBe(PROJECT_ID);
      // Path traversal characters replaced with underscores
      expect(file.name).not.toContain('/');
      expect(file.name).not.toContain('\\');
      expect(file.deleted).toBe(false);
    });

    it('should throw error if filename is invalid or empty', () => {
      expect(() =>
        ManuscriptFile.create({
          projectId: PROJECT_ID,
          name: '',
          mimeType: 'application/octet-stream',
          sizeBytes: 512,
          hash: validHash,
        }),
      ).toThrow();
    });

    it('should throw StorageQuotaExceededException if file exceeds MAX_FILE_SIZE_BYTES (1GB)', () => {
      expect(() =>
        ManuscriptFile.create({
          projectId: PROJECT_ID,
          name: 'huge_asset.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: MAX_FILE_SIZE_BYTES + 1024,
          hash: validHash,
        }),
      ).toThrow(StorageQuotaExceededException);
    });

    it('should support soft delete and restoration', () => {
      const file = ManuscriptFile.create({
        projectId: PROJECT_ID,
        name: 'plot.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        hash: validHash,
      });

      expect(file.deleted).toBe(false);
      file.markDeleted();
      expect(file.deleted).toBe(true);
      expect(file.deletedAt).toBeInstanceOf(Date);

      file.restore();
      expect(file.deleted).toBe(false);
      expect(file.deletedAt).toBeNull();
    });

    it('should rename file and increment revision count', () => {
      const file = ManuscriptFile.create({
        projectId: PROJECT_ID,
        name: 'old_chart.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        hash: validHash,
      });

      expect(file.rev).toBe(0);
      file.rename('new_chart.png');
      expect(file.name).toBe('new_chart.png');
      expect(file.rev).toBe(1);
    });
  });

  // =========================================================================
  // 3. ADAPTERS
  // =========================================================================
  describe('Adapters', () => {
    describe('CryptoGitBlobHasherAdapter', () => {
      it('should compute exact Git blob SHA-1 matching git hash-object calculation', async () => {
        // Git blob hash of empty string: git hash-object -t blob --stdin <<< ""
        // Header: "blob 0\0", hash: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
        const emptyStream = Readable.from(Buffer.alloc(0));
        const result = await hasher.hashStream(emptyStream);

        expect(result.contentHash.getValue()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
        expect(result.sizeBytes).toBe(0);

        // Verify replay stream is readable and matches original content
        const replayedBuffer = await streamToBuffer(result.dataStream);
        expect(replayedBuffer.length).toBe(0);
      });

      it('should compute exact Git blob SHA-1 for known text content', async () => {
        const content = Buffer.from('hello world\n', 'utf8');
        // Git header: `blob 12\0hello world\n`
        const expectedGitSha1 = crypto
          .createHash('sha1')
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest('hex');

        const stream = Readable.from(content);
        const result = await hasher.hashStream(stream);

        expect(result.contentHash.getValue()).toBe(expectedGitSha1);
        expect(result.sizeBytes).toBe(content.length);

        const replayedBuffer = await streamToBuffer(result.dataStream);
        expect(replayedBuffer.toString('utf8')).toBe('hello world\n');
      });

      it('should support hashBuffer directly', () => {
        const content = Buffer.from('\\documentclass{article}\n\\begin{document}\nFlux\\end{document}');
        const result = hasher.hashBuffer(content);

        const expectedSha1 = crypto
          .createHash('sha1')
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest('hex');

        expect(result.contentHash.getValue()).toBe(expectedSha1);
        expect(result.sizeBytes).toBe(content.length);
      });
    });

    describe('LocalDiskBinaryStorageAdapter', () => {
      it('should write stream atomically, check existence, and read back identical stream', async () => {
        const payload = Buffer.from('Quantum Computing Simulation Dataset - Figure 1');
        const storageKey = 'blobs/test/fig1.bin';

        // 1. Write
        await localStorage.sendStream(BUCKET, storageKey, Readable.from(payload));

        // 2. Exists
        const exists = await localStorage.checkObjectExists(BUCKET, storageKey);
        expect(exists).toBe(true);

        // 3. Read
        const readStream = await localStorage.getObjectStream(BUCKET, storageKey);
        const readBackBuffer = await streamToBuffer(readStream);
        expect(readBackBuffer.equals(payload)).toBe(true);

        // 4. Delete
        await localStorage.deleteObject(BUCKET, storageKey);
        const existsAfterDelete = await localStorage.checkObjectExists(BUCKET, storageKey);
        expect(existsAfterDelete).toBe(false);
      });

      it('should support partial byte-range reading (RFC 7233 slice)', async () => {
        const fullContent = Buffer.from('0123456789ABCDEF'); // 16 bytes
        const storageKey = 'blobs/test/slice.bin';

        await localStorage.sendStream(BUCKET, storageKey, Readable.from(fullContent));

        // Read bytes 4 to 9 ('456789')
        const sliceStream = await localStorage.getObjectStream(BUCKET, storageKey, { start: 4, end: 9 });
        const sliceBuffer = await streamToBuffer(sliceStream);

        expect(sliceBuffer.toString('utf8')).toBe('456789');
      });
    });
  });

  // =========================================================================
  // 4. USE CASES
  // =========================================================================
  describe('Use Cases', () => {
    it('UploadManuscriptFileUseCase: should upload file and deduplicate by hash', async () => {
      const imagePayload = Buffer.from('PNG_IMAGE_BINARY_DATA_TEST_123');

      // First upload
      const uploadedFile1 = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'figure1.png',
        mimeType: 'image/png',
        stream: Readable.from(imagePayload),
      });

      expect(uploadedFile1.id).toBeDefined();
      expect(uploadedFile1.name).toBe('figure1.png');
      expect(uploadedFile1.sizeBytes).toBe(imagePayload.length);
      expect(uploadedFile1.storageKey.getValue()).toContain('blobs/');

      // Verify file is stored in local storage
      const existsInStorage = await localStorage.checkObjectExists(
        uploadedFile1.bucketName,
        uploadedFile1.storageKey.getValue(),
      );
      expect(existsInStorage).toBe(true);

      // Second upload with identical content (Deduplication check)
      const uploadedFile2 = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'figure1_copy.png',
        mimeType: 'image/png',
        stream: Readable.from(imagePayload),
      });

      expect(uploadedFile2.hash.getValue()).toBe(uploadedFile1.hash.getValue());
      expect(uploadedFile2.storageKey.getValue()).toBe(uploadedFile1.storageKey.getValue());
    });

    it('StreamManuscriptFileUseCase: should stream full content when no range header is supplied', async () => {
      const data = Buffer.from('Lorem ipsum dolor sit amet, consectetur adipiscing elit.');
      const file = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'sample.txt',
        mimeType: 'text/plain',
        stream: Readable.from(data),
      });

      const result = await streamUseCase.execute({
        projectId: PROJECT_ID,
        fileId: file.id,
      });

      expect(result.file.id).toBe(file.id);
      expect(result.isPartialContent).toBe(false);
      expect(result.byteRange).toBeNull();
      expect(result.contentLength).toBe(data.length);

      const streamed = await streamToBuffer(result.stream);
      expect(streamed.toString('utf8')).toBe(data.toString('utf8'));
    });

    it('StreamManuscriptFileUseCase: should stream partial content (206) when Range header is provided', async () => {
      const data = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'); // 26 bytes
      const file = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'alphabet.txt',
        mimeType: 'text/plain',
        stream: Readable.from(data),
      });

      // Request range bytes 5-10 ("FGHIJK")
      const result = await streamUseCase.execute({
        projectId: PROJECT_ID,
        fileId: file.id,
        rangeHeader: 'bytes=5-10',
      });

      expect(result.isPartialContent).toBe(true);
      expect(result.byteRange?.start).toBe(5);
      expect(result.byteRange?.end).toBe(10);
      expect(result.contentLength).toBe(6);

      const streamed = await streamToBuffer(result.stream);
      expect(streamed.toString('utf8')).toBe('FGHIJK');
    });

    it('StreamManuscriptFileUseCase: should throw FileNotFoundException when file does not exist', async () => {
      await expect(
        streamUseCase.execute({
          projectId: PROJECT_ID,
          fileId: 'non-existent-file-id',
        }),
      ).rejects.toThrow(FileNotFoundException);
    });

    it('GetManuscriptFileHeadUseCase: should return metadata without opening body stream', async () => {
      const data = Buffer.from('PDF_METADATA_HEADER_TEST');
      const file = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'doc.pdf',
        mimeType: 'application/pdf',
        stream: Readable.from(data),
      });

      const headResult = await headUseCase.execute({
        projectId: PROJECT_ID,
        fileId: file.id,
      });

      expect(headResult.file.id).toBe(file.id);
      expect(headResult.file.name).toBe('doc.pdf');
      expect(headResult.file.sizeBytes).toBe(data.length);
    });

    it('DeleteManuscriptFileUseCase: should soft delete file and keep physical blob', async () => {
      const data = Buffer.from('Data to be soft deleted');
      const file = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'soft_delete.dat',
        mimeType: 'application/octet-stream',
        stream: Readable.from(data),
      });

      await deleteUseCase.execute({
        projectId: PROJECT_ID,
        fileId: file.id,
        purgePhysicalBlob: false,
      });

      const deletedFile = await inMemoryRepo.findByProjectAndId(PROJECT_ID, file.id);
      expect(deletedFile?.deleted).toBe(true);
      // Physical blob must still exist in storage
      expect(await localStorage.checkObjectExists(file.bucketName, file.storageKey.getValue())).toBe(true);
    });

    it('DeleteManuscriptFileUseCase: should purge physical blob when requested', async () => {
      const data = Buffer.from('Data to be completely purged');
      const file = await uploadUseCase.execute({
        projectId: PROJECT_ID,
        name: 'purge_me.dat',
        mimeType: 'application/octet-stream',
        stream: Readable.from(data),
      });

      await deleteUseCase.execute({
        projectId: PROJECT_ID,
        fileId: file.id,
        purgePhysicalBlob: true,
      });

      expect(await localStorage.checkObjectExists(file.bucketName, file.storageKey.getValue())).toBe(false);
    });
  });

  // =========================================================================
  // 5. FILESTORE SERVICE (FAÇADE FOR CLSI & STRUCTURE)
  // =========================================================================
  describe('FilestoreService (Façade)', () => {
    it('should open direct read stream without HTTP overhead for CLSI compilation', async () => {
      const logoData = Buffer.from('GRAPHICS_LOGO_DATA_STREAM');
      const file = await filestoreService.uploadFileFromBuffer(
        PROJECT_ID,
        'figures/logo.eps',
        logoData,
        'application/postscript',
      );

      const clsiFeed = await filestoreService.openReadStream(PROJECT_ID, file.id);
      expect(clsiFeed.file.id).toBe(file.id);

      const streamBytes = await streamToBuffer(clsiFeed.stream);
      expect(streamBytes.equals(logoData)).toBe(true);
    });

    it('should list all active files in a manuscript project', async () => {
      await filestoreService.uploadFileFromBuffer(PROJECT_ID, 'a.png', Buffer.from('a'));
      await filestoreService.uploadFileFromBuffer(PROJECT_ID, 'b.png', Buffer.from('b'));

      const list = await filestoreService.listFiles(PROJECT_ID);
      expect(list.length).toBe(2);
      expect(list.map((f) => f.name).sort()).toEqual(['a.png', 'b.png']);
    });
  });

  // =========================================================================
  // 6. FILESTORE CONTROLLER (OVERLEAF HTTP REST API)
  // =========================================================================
  describe('FilestoreController', () => {
    it('should handle raw stream uploads with query filename', async () => {
      const rawData = Buffer.from('RAW_BODY_UPLOAD_STREAM');
      const mockReq: any = {
        raw: Readable.from(rawData),
        isMultipart: () => false,
        headers: {
          'content-type': 'application/pdf',
        },
      };

      const resDto = await filestoreController.uploadFile(PROJECT_ID, mockReq, 'appendix.pdf');
      expect(resDto.name).toBe('appendix.pdf');
      expect(resDto.sizeBytes).toBe(rawData.length);
      expect(resDto.mimeType).toBe('application/pdf');
    });

    it('should handle multipart form uploads', async () => {
      const fileContent = Buffer.from('MULTIPART_FILE_STREAM');
      const mockReq: any = {
        isMultipart: () => true,
        file: async () => ({
          filename: 'dataset.csv',
          mimetype: 'text/csv',
          file: Readable.from(fileContent),
        }),
        headers: {},
      };

      const resDto = await filestoreController.uploadFile(PROJECT_ID, mockReq);
      expect(resDto.name).toBe('dataset.csv');
      expect(resDto.mimeType).toBe('text/csv');
      expect(resDto.sizeBytes).toBe(fileContent.length);
    });

    it('should apply Mobile Safari HTML XSS defense (Overleaf Parity)', async () => {
      // Overleaf vulnerability guard: If user agent is Mobile Safari and file is .html,
      // force Content-Type to text/plain to prevent script execution on iOS Safari.
      const htmlContent = Buffer.from('<html><body><script>alert("xss")</script></body></html>');
      const htmlFile = await filestoreService.uploadFileFromBuffer(
        PROJECT_ID,
        'index.html',
        htmlContent,
        'text/html',
      );

      const headersSet = new Map<string, string>();
      const responseStream = new PassThrough();
      let responseStatus = 200;

      const mockRes: any = {
        raw: responseStream,
        header: (name: string, val: string) => {
          headersSet.set(name.toLowerCase(), val);
        },
        status: (code: number) => {
          responseStatus = code;
          return mockRes;
        },
      };

      const mobileSafariUserAgent =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

      await filestoreController.streamFile(
        PROJECT_ID,
        htmlFile.id,
        undefined,
        mobileSafariUserAgent,
        mockRes,
      );

      // Must be overridden to text/plain on Mobile Safari!
      expect(headersSet.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(headersSet.get('accept-ranges')).toBe('bytes');
      expect(responseStatus).toBe(200);
    });

    it('should respond with 206 Partial Content when Range header is sent to controller', async () => {
      const content = Buffer.from('0123456789'); // 10 bytes
      const file = await filestoreService.uploadFileFromBuffer(
        PROJECT_ID,
        'numbers.txt',
        content,
        'text/plain',
      );

      const headersSet = new Map<string, string>();
      const responseStream = new PassThrough();
      let responseStatus = 200;

      const mockRes: any = {
        raw: responseStream,
        header: (name: string, val: string) => {
          headersSet.set(name.toLowerCase(), val);
        },
        status: (code: number) => {
          responseStatus = code;
          return mockRes;
        },
      };

      await filestoreController.streamFile(
        PROJECT_ID,
        file.id,
        'bytes=2-6', // '23456'
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        mockRes,
      );

      expect(responseStatus).toBe(206);
      expect(headersSet.get('content-range')).toBe('bytes 2-6/10');
      expect(headersSet.get('content-length')).toBe('5');
    });

    it('should respond with 416 Range Not Satisfiable when range is out of bounds', async () => {
      const content = Buffer.from('SHORT'); // 5 bytes
      const file = await filestoreService.uploadFileFromBuffer(
        PROJECT_ID,
        'short.txt',
        content,
        'text/plain',
      );

      const headersSet = new Map<string, string>();
      let responseStatus = 200;
      let sentBody = '';

      const mockRes: any = {
        header: (name: string, val: string) => {
          headersSet.set(name.toLowerCase(), val);
        },
        status: (code: number) => {
          responseStatus = code;
          return mockRes;
        },
        send: (body: string) => {
          sentBody = body;
        },
      };

      await filestoreController.streamFile(
        PROJECT_ID,
        file.id,
        'bytes=10-20', // Out of bounds
        undefined,
        mockRes,
      );

      expect(responseStatus).toBe(416);
      expect(headersSet.get('content-range')).toBe('bytes */5');
      expect(sentBody.toLowerCase()).toContain('unsatisfiable');
    });

    it('should return metadata on HEAD /project/:projectId/file/:fileId', async () => {
      const data = Buffer.from('HEAD_PROBE_TEST');
      const file = await filestoreService.uploadFileFromBuffer(
        PROJECT_ID,
        'probe.dat',
        data,
        'application/octet-stream',
      );

      const headersSet = new Map<string, string>();
      let responseStatus = 0;

      const mockRes: any = {
        header: (name: string, val: string) => {
          headersSet.set(name.toLowerCase(), val);
        },
        status: (code: number) => {
          responseStatus = code;
          return mockRes;
        },
        send: () => {},
      };

      await filestoreController.getFileHead(PROJECT_ID, file.id, mockRes);

      expect(responseStatus).toBe(200);
      expect(headersSet.get('content-length')).toBe(data.length.toString());
      expect(headersSet.get('content-type')).toBe('application/octet-stream');
      expect(headersSet.get('accept-ranges')).toBe('bytes');
    });

    it('should return signed URL or null', async () => {
      const file = await filestoreService.uploadFileFromBuffer(
        PROJECT_ID,
        'test.png',
        Buffer.from('test'),
      );

      const result = await filestoreController.getSignedUrl(PROJECT_ID, file.id);
      expect(result).toHaveProperty('signedUrl');
    });
  });
});
