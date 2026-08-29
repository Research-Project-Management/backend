import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from '../library/library-test-harness';
import {
  STORAGE_PORT,
  IStoragePort,
} from '../../../src/modules/storage/storage.port';
import { R2Service } from '../../../src/modules/storage/r2/r2.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';

describe('StorageAdapter Integration & Invariants (STORAGE_PORT)', () => {
  let harness: LibraryTestHarness;
  let workspaceA: TestWorkspaceFixture;
  let workspaceB: TestWorkspaceFixture;
  let storagePort: IStoragePort;
  let r2Service: R2Service;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    workspaceA = await harness.seedWorkspaceFixture();
    workspaceB = await harness.seedWorkspaceFixture();
    storagePort = harness.moduleRef.get<IStoragePort>(STORAGE_PORT);
    r2Service = harness.moduleRef.get<R2Service>(R2Service);
  }, 60000);

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  }, 30000);

  it('1. Upload → File record with /api/files/r2/ URL → readOwnedFile returns exact buffer', async () => {
    const rawContent = Buffer.from(
      `%PDF-1.4 TEST PAYLOAD ${crypto.randomUUID()}`,
    );
    const key = `workspaces/${workspaceA.workspaceId}/papers/${Date.now()}-test.pdf`;

    // 1. Upload buffer via R2Service
    const uploadResult = await r2Service.uploadBuffer(
      key,
      rawContent,
      'application/pdf',
    );
    expect(uploadResult.url).toBe(`/api/files/r2/${key}`);
    expect(uploadResult.path).toBe(key);

    // 2. Persist File record in database
    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'test-paper.pdf',
        mimeType: 'application/pdf',
        size: rawContent.length,
        url: uploadResult.url,
        workspaceId: workspaceA.workspaceId,
        authorId: workspaceA.ownerUserId,
      },
    });

    // 3. Read owned file via StoragePort
    const result = await storagePort.readOwnedFile({
      workspaceId: workspaceA.workspaceId,
      fileId,
    });

    expect(result.fileId).toBe(fileId);
    expect(result.filename).toBe('test-paper.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.storageKey).toBe(key);
    expect(result.buffer.equals(rawContent)).toBe(true);

    // Cleanup
    await r2Service.deleteObject(key);
  });

  it('2. Workspace Isolation: rejects access from a different workspace with ForbiddenException', async () => {
    const rawContent = Buffer.from('ISOLATION TEST CONTENT');
    const key = `workspaces/${workspaceA.workspaceId}/papers/${Date.now()}-iso.pdf`;
    const uploadResult = await r2Service.uploadBuffer(
      key,
      rawContent,
      'application/pdf',
    );

    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'isolated.pdf',
        mimeType: 'application/pdf',
        url: uploadResult.url,
        workspaceId: workspaceA.workspaceId,
        authorId: workspaceA.ownerUserId,
      },
    });

    // Attempting to read file belonging to workspaceA from workspaceB
    await expect(
      storagePort.readOwnedFile({
        workspaceId: workspaceB.workspaceId,
        fileId,
      }),
    ).rejects.toThrow(ForbiddenException);

    await r2Service.deleteObject(key);
  });

  it('3. Trashed File: rejects reading a file in trash with NotFoundException', async () => {
    const rawContent = Buffer.from('TRASH TEST CONTENT');
    const key = `workspaces/${workspaceA.workspaceId}/papers/${Date.now()}-trash.pdf`;
    const uploadResult = await r2Service.uploadBuffer(
      key,
      rawContent,
      'application/pdf',
    );

    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'trashed.pdf',
        mimeType: 'application/pdf',
        url: uploadResult.url,
        workspaceId: workspaceA.workspaceId,
        authorId: workspaceA.ownerUserId,
        trashedAt: new Date(),
      },
    });

    await expect(
      storagePort.readOwnedFile({
        workspaceId: workspaceA.workspaceId,
        fileId,
      }),
    ).rejects.toThrow(NotFoundException);

    await r2Service.deleteObject(key);
  });

  it('4. Missing Object: throws NotFoundException when storage object is absent in R2/local storage', async () => {
    const nonExistentKey = `workspaces/${workspaceA.workspaceId}/papers/missing-${Date.now()}.pdf`;
    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'missing.pdf',
        mimeType: 'application/pdf',
        url: `/api/files/r2/${nonExistentKey}`,
        workspaceId: workspaceA.workspaceId,
        authorId: workspaceA.ownerUserId,
      },
    });

    await expect(
      storagePort.readOwnedFile({
        workspaceId: workspaceA.workspaceId,
        fileId,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('5. Invalid URL Format: rejects files with invalid storage URL prefix with NotFoundException', async () => {
    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'invalid-url.pdf',
        mimeType: 'application/pdf',
        url: `https://external-s3.amazonaws.com/bucket/file.pdf`,
        workspaceId: workspaceA.workspaceId,
        authorId: workspaceA.ownerUserId,
      },
    });

    await expect(
      storagePort.readOwnedFile({
        workspaceId: workspaceA.workspaceId,
        fileId,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
