import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatAttachmentService } from '@/modules/chat/services/chat-attachment.service';
import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_FILE_BYTES,
} from '@/modules/chat/chat.constant';

describe('ChatAttachmentService Unit Tests', () => {
  let service: ChatAttachmentService;
  let mockStorageAdapter: any;
  let mockChatService: any;
  let mockConfigService: any;

  beforeEach(() => {
    mockStorageAdapter = {
      getPresignedUploadUrl: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
      put: jest.fn(),
      getStream: jest.fn(),
      stat: jest.fn(),
      exists: jest.fn(),
    };

    mockChatService = {
      verifyConversationAccess: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'R2_PUBLIC_URL') return 'https://cdn.flux.local';
        return null;
      }),
    };

    service = new ChatAttachmentService(
      mockStorageAdapter,
      mockChatService,
      mockConfigService,
    );
  });

  describe('validateAttachmentLimits', () => {
    it('throws BadRequestException when sizeBytes is 0 or negative', () => {
      expect(() => service.validateAttachmentLimits('test.pdf', 0)).toThrow(
        BadRequestException,
      );

      expect(() => service.validateAttachmentLimits('test.pdf', -100)).toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for dangerous blocked extensions', () => {
      expect(() =>
        service.validateAttachmentLimits('trojan.exe', 1024),
      ).toThrow(BadRequestException);

      expect(() => service.validateAttachmentLimits('script.sh', 1024)).toThrow(
        BadRequestException,
      );

      expect(() =>
        service.validateAttachmentLimits('malware.bat', 1024),
      ).toThrow(BadRequestException);
    });

    it('throws PayloadTooLargeException when image exceeds 20MB limit', () => {
      const overLimit = MAX_CHAT_IMAGE_BYTES + 1;
      expect(() =>
        service.validateAttachmentLimits(
          'large_photo.png',
          overLimit,
          'image/png',
        ),
      ).toThrow(PayloadTooLargeException);
    });

    it('allows image within 20MB limit', () => {
      const withinLimit = 15 * 1024 * 1024; // 15MB
      const res = service.validateAttachmentLimits(
        'photo.jpg',
        withinLimit,
        'image/jpeg',
      );
      expect(res.isImage).toBe(true);
      expect(res.cleanFilename).toBe('photo.jpg');
      expect(res.resolvedMime).toBe('image/jpeg');
    });

    it('throws PayloadTooLargeException when generic file exceeds 50MB limit', () => {
      const overLimit = MAX_CHAT_FILE_BYTES + 1;
      expect(() =>
        service.validateAttachmentLimits(
          'massive_dataset.zip',
          overLimit,
          'application/zip',
        ),
      ).toThrow(PayloadTooLargeException);
    });

    it('allows generic file within 50MB limit', () => {
      const withinLimit = 45 * 1024 * 1024; // 45MB
      const res = service.validateAttachmentLimits(
        'paper_dataset.tar.gz',
        withinLimit,
        'application/gzip',
      );
      expect(res.isImage).toBe(false);
      expect(res.cleanFilename).toBe('paper_dataset.tar.gz');
    });
  });

  describe('createPresignedUpload', () => {
    it('verifies conversation access and generates partitioned R2 storage key and presigned PUT URL', async () => {
      mockChatService.verifyConversationAccess.mockResolvedValue({
        id: 'conv-101',
      });
      mockStorageAdapter.getPresignedUploadUrl.mockResolvedValue(
        'https://r2.cloudflarestorage.com/upload-put-url',
      );

      const res = await service.createPresignedUpload('conv-101', 'user-42', {
        filename: 'experiment_results.pdf',
        sizeBytes: 2 * 1024 * 1024,
        mimeType: 'application/pdf',
      });

      expect(mockChatService.verifyConversationAccess).toHaveBeenCalledWith(
        'conv-101',
        'user-42',
      );
      expect(mockStorageAdapter.getPresignedUploadUrl).toHaveBeenCalledWith(
        expect.stringMatching(
          /^chat\/conv-101\/\d{4}\/\d{2}\/[a-f0-9-]+-experiment_results\.pdf$/,
        ),
        expect.objectContaining({
          mimeType: 'application/pdf',
          expiresInSeconds: 900,
        }),
      );

      expect(res.uploadUrl).toBe(
        'https://r2.cloudflarestorage.com/upload-put-url',
      );
      expect(res.maxSizeBytes).toBe(MAX_CHAT_FILE_BYTES);
      expect(res.type).toBe('file');
    });

    it('denies presigned upload if user is not authorized in conversation', async () => {
      mockChatService.verifyConversationAccess.mockRejectedValue(
        new ForbiddenException('Access denied'),
      );

      await expect(
        service.createPresignedUpload('conv-private', 'user-intruder', {
          filename: 'leak.png',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('completePresignedUpload', () => {
    it('validates storage key namespace and returns complete attachment record with CDN URL', async () => {
      mockChatService.verifyConversationAccess.mockResolvedValue({
        id: 'conv-101',
      });

      const storageKey = 'chat/conv-101/2026/11/abc-quantum.pdf';
      const res = await service.completePresignedUpload('conv-101', 'user-42', {
        storageKey,
        filename: 'quantum.pdf',
        sizeBytes: 10240,
        mimeType: 'application/pdf',
      });

      expect(res.name).toBe('quantum.pdf');
      expect(res.storageKey).toBe(storageKey);
      expect(res.url).toBe('https://cdn.flux.local/' + storageKey);
      expect(res.type).toBe('file');
    });

    it('throws ForbiddenException if storageKey points outside conversation room', async () => {
      mockChatService.verifyConversationAccess.mockResolvedValue({
        id: 'conv-101',
      });

      await expect(
        service.completePresignedUpload('conv-101', 'user-42', {
          storageKey: 'chat/conv-VICTIM/2026/11/secret.pdf',
          filename: 'secret.pdf',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('directUpload', () => {
    it('uploads buffer to R2 storage adapter and returns attachment result', async () => {
      mockChatService.verifyConversationAccess.mockResolvedValue({
        id: 'conv-101',
      });
      mockStorageAdapter.put.mockResolvedValue(undefined);

      const buffer = Buffer.from('PDF_DUMMY_CONTENT');
      const res = await service.uploadDirect('conv-101', 'user-42', {
        buffer,
        filename: 'draft.pdf',
        mimeType: 'application/pdf',
      });

      expect(mockStorageAdapter.put).toHaveBeenCalledWith(
        expect.stringMatching(
          /^chat\/conv-101\/\d{4}\/\d{2}\/[a-f0-9-]+-draft\.pdf$/,
        ),
        buffer,
        expect.objectContaining({
          mimeType: 'application/pdf',
          size: buffer.length,
        }),
      );
      expect(res.size).toBe(buffer.length);
      expect(res.type).toBe('file');
    });
  });

  describe('resolveAttachmentAccess', () => {
    it('returns direct CDN redirect when publicBaseUrl is configured', async () => {
      mockChatService.verifyConversationAccess.mockResolvedValue({
        id: 'conv-101',
      });

      const outcome = await service.resolveAttachmentAccess(
        'user-42',
        'chat/conv-101/2026/11/123-fig.png',
      );

      expect(outcome.kind).toBe('redirect');
      expect(outcome.url).toBe(
        'https://cdn.flux.local/chat/conv-101/2026/11/123-fig.png',
      );
    });
  });
});
