import {
  readSafeResponseBuffer,
  MAX_SAFE_HTTP_PAYLOAD_BYTES,
  PayloadTooLargeException,
} from '@/modules/library/core/utils/stream-buffer.util';
import { OcrWorkerPoolService } from '@/modules/library/extraction/services/ocr-worker-pool.service';

describe('OS-Level Resource Management & Stream Buffer Safety', () => {
  describe('1. readSafeResponseBuffer Backpressure and Size Limits', () => {
    it('reads small payload successfully from streaming response body', async () => {
      const sampleText = 'Academic PDF Content Sample';
      const sampleBytes = new TextEncoder().encode(sampleText);

      let chunkDelivered = false;
      const mockReader = {
        read: jest.fn().mockImplementation(() => {
          if (!chunkDelivered) {
            chunkDelivered = true;
            return Promise.resolve({ done: false, value: sampleBytes });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
        releaseLock: jest.fn(),
      };

      const mockResponse = {
        headers: {
          get: jest.fn().mockReturnValue(String(sampleBytes.length)),
        },
        body: {
          getReader: jest.fn().mockReturnValue(mockReader),
        },
      } as unknown as Response;

      const result = await readSafeResponseBuffer(mockResponse, 1024 * 1024);
      expect(result.toString()).toBe(sampleText);
      expect(mockReader.read).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it('rejects early without reading stream when Content-Length header exceeds limit', async () => {
      const mockReader = {
        read: jest.fn(),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      };

      const mockResponse = {
        headers: {
          get: jest.fn().mockReturnValue(String(MAX_SAFE_HTTP_PAYLOAD_BYTES + 1024)),
        },
        body: {
          getReader: jest.fn().mockReturnValue(mockReader),
        },
      } as unknown as Response;

      await expect(
        readSafeResponseBuffer(mockResponse, MAX_SAFE_HTTP_PAYLOAD_BYTES),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(mockReader.read).not.toHaveBeenCalled();
    });

    it('aborts and cancels stream when streaming bytes exceed maxBytes limit', async () => {
      const largeChunk = new Uint8Array(2048); // 2KB chunk
      const mockReader = {
        read: jest
          .fn()
          .mockResolvedValueOnce({ done: false, value: largeChunk })
          .mockResolvedValueOnce({ done: false, value: largeChunk }),
        cancel: jest.fn().mockResolvedValue(undefined),
        releaseLock: jest.fn(),
      };

      const mockResponse = {
        headers: {
          get: jest.fn().mockReturnValue(null),
        },
        body: {
          getReader: jest.fn().mockReturnValue(mockReader),
        },
      } as unknown as Response;

      // Limit to 1024 bytes (1 KB)
      await expect(
        readSafeResponseBuffer(mockResponse, 1024),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });
  });

  describe('2. OCR Worker Pool OS Process & Signal Lifecycle', () => {
    let service: OcrWorkerPoolService;

    beforeEach(() => {
      service = new OcrWorkerPoolService();
    });

    it('computes safe concurrency bounded by OS cores and memory', () => {
      expect(service.concurrency).toBeGreaterThanOrEqual(1);
      expect(service.concurrency).toBeLessThanOrEqual(4);
    });

    it('terminates all individual workers on OS beforeApplicationShutdown signal', async () => {
      const mockWorker1 = { terminate: jest.fn().mockResolvedValue(undefined) };
      const mockWorker2 = { terminate: jest.fn().mockResolvedValue(undefined) };
      const mockScheduler = { terminate: jest.fn().mockResolvedValue(undefined) };

      (service as any).scheduler = mockScheduler;
      (service as any).workers = [mockWorker1, mockWorker2];

      await service.beforeApplicationShutdown('SIGTERM');

      expect(mockWorker1.terminate).toHaveBeenCalled();
      expect(mockWorker2.terminate).toHaveBeenCalled();
      expect(mockScheduler.terminate).toHaveBeenCalled();
      expect((service as any).workers).toEqual([]);
      expect((service as any).scheduler).toBeUndefined();
    });
  });

  describe('3. Zero-Copy TypedArray Buffer Slicing Invariant', () => {
    it('verifies that TypedArray view shares identical ArrayBuffer reference without heap duplication', () => {
      const originalBuffer = Buffer.from('PDF-HEADER-BODY-TRAILER-RESOURCES');
      const zeroCopyView = new Uint8Array(
        originalBuffer.buffer,
        originalBuffer.byteOffset,
        originalBuffer.byteLength,
      );

      expect(zeroCopyView.buffer).toBe(originalBuffer.buffer);
      expect(zeroCopyView.byteOffset).toBe(originalBuffer.byteOffset);
      expect(zeroCopyView.byteLength).toBe(originalBuffer.byteLength);
    });
  });
});
