import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fromPartial } from '@total-typescript/shoehorn';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';
import {
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_IMAGE_BYTES,
} from '@/modules/project/chat/chat.constant';
import { ChatAttachmentService } from '@/modules/project/chat/services/chat-attachment.service';
import { ChatService } from '@/modules/project/chat/services/chat.service';

describe('ChatAttachmentService Unit Tests', () => {
  let service: ChatAttachmentService;
  let mockStorageAdapter: jest.Mocked<IStorageAdapter>;
  let verifyConversationAccess: jest.Mock;

  beforeEach(() => {
    mockStorageAdapter = fromPartial<jest.Mocked<IStorageAdapter>>({
      getPresignedUploadUrl: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
      put: jest.fn(),
      getStream: jest.fn(),
      stat: jest.fn(),
      exists: jest.fn(),
    });

    verifyConversationAccess = jest.fn();

    service = new ChatAttachmentService(
      mockStorageAdapter,
      fromPartial<ChatService>({ verifyConversationAccess }),
      fromPartial<ConfigService>({
        get: jest.fn((key: string) =>
          key === 'R2_PUBLIC_URL' ? 'https://cdn.flux.local' : null,
        ),
      }),
    );
  });

  it('validates size bounds, image vs generic file limits (20MB / 50MB), and blocked executable extensions', () => {
    expect(() => service.validateAttachmentLimits('test.pdf', 0)).toThrow(
      BadRequestException,
    );
    expect(() => service.validateAttachmentLimits('test.pdf', -100)).toThrow(
      BadRequestException,
    );

    for (const blocked of ['trojan.exe', 'script.sh', 'malware.bat']) {
      expect(() => service.validateAttachmentLimits(blocked, 1024)).toThrow(
        BadRequestException,
      );
    }

    expect(() =>
      service.validateAttachmentLimits(
        'large_photo.png',
        MAX_CHAT_IMAGE_BYTES + 1,
        'image/png',
      ),
    ).toThrow(PayloadTooLargeException);

    expect(
      service.validateAttachmentLimits(
        'photo.jpg',
        15 * 1024 * 1024,
        'image/jpeg',
      ),
    ).toMatchObject({
      isImage: true,
      cleanFilename: 'photo.jpg',
      resolvedMime: 'image/jpeg',
    });

    expect(() =>
      service.validateAttachmentLimits(
        'massive.zip',
        MAX_CHAT_FILE_BYTES + 1,
        'application/zip',
      ),
    ).toThrow(PayloadTooLargeException);

    expect(
      service.validateAttachmentLimits(
        'paper_dataset.tar.gz',
        45 * 1024 * 1024,
        'application/gzip',
      ),
    ).toMatchObject({
      isImage: false,
      cleanFilename: 'paper_dataset.tar.gz',
    });
  });

  it('enforces conversation access, room-scoped storageKey isolation, direct upload, and CDN redirect resolution', async () => {
    verifyConversationAccess.mockRejectedValueOnce(
      new ForbiddenException('Access denied'),
    );
    await expect(
      service.createPresignedUpload('conv-private', 'user-intruder', {
        filename: 'leak.png',
        sizeBytes: 1024,
      }),
    ).rejects.toThrow(ForbiddenException);

    verifyConversationAccess.mockResolvedValue({ id: 'conv-101' });
    mockStorageAdapter.getPresignedUploadUrl.mockResolvedValue(
      'https://r2.cloudflarestorage.com/upload-put-url',
    );

    const presigned = await service.createPresignedUpload('conv-101', 'user-42', {
      filename: 'experiment_results.pdf',
      sizeBytes: 2 * 1024 * 1024,
      mimeType: 'application/pdf',
    });
    expect(presigned.uploadUrl).toBe(
      'https://r2.cloudflarestorage.com/upload-put-url',
    );
    expect(presigned.storageKey).toMatch(
      /^chat\/conv-101\/\d{4}\/\d{2}\/[a-f0-9-]+-experiment_results\.pdf$/,
    );

    // Cross-room storageKey spoofing blocked
    await expect(
      service.completePresignedUpload('conv-101', 'user-42', {
        storageKey: 'chat/conv-VICTIM/2026/11/secret.pdf',
        filename: 'secret.pdf',
        sizeBytes: 1024,
      }),
    ).rejects.toThrow(ForbiddenException);

    const storageKey = 'chat/conv-101/2026/11/abc-quantum.pdf';
    const completed = await service.completePresignedUpload('conv-101', 'user-42', {
      storageKey,
      filename: 'quantum.pdf',
      sizeBytes: 10240,
      mimeType: 'application/pdf',
    });
    expect(completed.url).toBe('https://cdn.flux.local/' + storageKey);

    mockStorageAdapter.put.mockResolvedValue(undefined);
    const buffer = Buffer.from('PDF_DUMMY_CONTENT');
    const direct = await service.uploadDirect('conv-101', 'user-42', {
      buffer,
      filename: 'draft.pdf',
      mimeType: 'application/pdf',
    });
    expect(direct.size).toBe(buffer.length);

    await expect(
      service.resolveAttachmentAccess(
        'user-42',
        'chat/conv-101/2026/11/123-fig.png',
      ),
    ).resolves.toEqual({
      kind: 'redirect',
      url: 'https://cdn.flux.local/chat/conv-101/2026/11/123-fig.png',
    });
  });
});
