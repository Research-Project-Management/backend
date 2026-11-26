import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BlobStatus, StorageBlobRecord } from '@/modules/files/types/files.type';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { FilesFacade } from '@/modules/files/files.facade';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';

describe('FilesModule P1 — local resume parity & default 302 read offload', () => {
  it('LocalStorageAdapter.listUploadedParts lists staged parts sorted with md5 eTags', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-files-p1-'));
    try {
      const adapter = new LocalStorageAdapter(dir);
      const { uploadId } = await adapter.initiateMultipartUpload('k');
      expect(await adapter.listUploadedParts('k', uploadId)).toEqual([]);

      const p2 = await adapter.putPart(uploadId, 2, Buffer.from('two'));
      const p1 = await adapter.putPart(uploadId, 1, Buffer.from('one'));

      expect(await adapter.listUploadedParts('k', uploadId)).toEqual([
        { partNumber: 1, eTag: p1.eTag },
        { partNumber: 2, eTag: p2.eTag },
      ]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  const blobId = '33333333-3333-4333-8333-333333333333';
  const blob: StorageBlobRecord = {
    id: blobId,
    contentHashHex: 'a'.repeat(64),
    hashAlgorithm: 'SHA256',
    sizeBytes: 10n,
    mimeType: 'application/pdf',
    checksumVerified: true,
    s3Key: 'blobs/aa/aa/' + 'a'.repeat(64),
    s3Bucket: 'flux',
    storageClass: 'STANDARD',
    refCount: 1,
    status: BlobStatus.READY,
    createdAt: new Date(),
    tombstoneAt: null,
    claimedAt: null,
  };

  const buildFacade = (supportsDirectDownload?: boolean) => {
    const driver = {
      supportsDirectDownload,
      getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://r2/signed'),
      getStream: jest.fn().mockResolvedValue({
        stream: null,
        contentLength: 10,
      }),
    } as unknown as jest.Mocked<IStorageAdapter>;
    const blobRepo = {
      findById: jest.fn().mockResolvedValue(blob),
    } as unknown as BlobRepository;
    const facade = new FilesFacade(
      driver,
      new BlobService(driver, blobRepo),
      blobRepo,
      {} as QuotaRepository,
      {} as FilesUploadService,
    );
    return { facade, driver };
  };

  it('redirects by default on direct-download capable storage and honors explicit proxy opt-out', async () => {
    const { facade } = buildFacade(true);
    const base = { blobId, userId: 'u1', isDownload: false };

    const byDefault = await facade.resolveAuthorizedBlobContent(base);
    expect(byDefault).toEqual({
      kind: 'redirect',
      location: 'https://r2/signed',
    });

    const proxied = await facade.resolveAuthorizedBlobContent({
      ...base,
      redirect: false,
    });
    expect(proxied.kind).toBe('stream');
  });

  it('keeps streaming through the API when storage has no direct download (local)', async () => {
    const { facade } = buildFacade(undefined);
    const res = await facade.resolveAuthorizedBlobContent({
      blobId,
      userId: 'u1',
      isDownload: false,
    });
    expect(res.kind).toBe('stream');
  });
});
