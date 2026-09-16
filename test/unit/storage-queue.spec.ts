import { StorageQueueProducer } from '@/modules/storage/application/queues/storage-queue.producer';
import { StorageQueueConsumer } from '@/modules/storage/application/queues/storage-queue.consumer';
import { StorageProcessingJobData } from '@/modules/storage/application/queues/storage-queue.types';
import { IStorageDriver } from '@/modules/storage/domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '@/modules/storage/domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '@/modules/storage/domain/ports/storage-blob.repository.port';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { FileScope } from '@/modules/storage/domain/value-objects/file-scope.vo';
import { Queue, Job } from 'bullmq';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

describe('Storage BullMQ Queue & Worker Suite', () => {
  describe('StorageQueueProducer', () => {
    let producer: StorageQueueProducer;
    let mockQueue: jest.Mocked<Partial<Queue<StorageProcessingJobData>>>;

    beforeEach(() => {
      mockQueue = {
        add: jest.fn().mockResolvedValue({ id: 'proc-f1' } as any),
      };
      producer = new StorageQueueProducer(mockQueue as Queue<StorageProcessingJobData>);
    });

    it('should enqueue a processing job with exponential backoff and job deduplication ID', async () => {
      const payload: StorageProcessingJobData = {
        fileId: 'file-123',
        blobId: 'blob-456',
        s3Key: 'blobs/hash-abc',
        mimeType: 'image/png',
        filename: 'figure1.png',
        userId: 'user-789',
        projectId: 'project-999',
      };

      await producer.queueFileProcessing(payload);

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-file',
        payload,
        expect.objectContaining({
          jobId: 'proc-file-123',
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        }),
      );
    });

    it('should gracefully handle absent queue without throwing', async () => {
      const emptyProducer = new StorageQueueProducer(undefined);
      await expect(
        emptyProducer.queueFileProcessing({
          fileId: 'file-123',
          blobId: 'blob-456',
          s3Key: 'blobs/hash-abc',
          mimeType: 'image/png',
          filename: 'figure1.png',
          userId: 'user-789',
        }),
      ).resolves.not.toThrow();
    });

    it('should handle queue.add failure gracefully without crashing', async () => {
      mockQueue.add = jest.fn().mockRejectedValue(new Error('Redis connection down'));
      await expect(
        producer.queueFileProcessing({
          fileId: 'file-123',
          blobId: 'blob-456',
          s3Key: 'blobs/hash-abc',
          mimeType: 'image/png',
          filename: 'figure1.png',
          userId: 'user-789',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('StorageQueueConsumer', () => {
    let consumer: StorageQueueConsumer;
    let mockDriver: jest.Mocked<IStorageDriver>;
    let mockNodeRepo: jest.Mocked<IStorageNodeRepository>;
    let mockBlobRepo: jest.Mocked<IStorageBlobRepository>;

    beforeEach(() => {
      mockDriver = {
        put: jest.fn().mockResolvedValue(undefined),
        getStream: jest.fn(),
        stat: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        exists: jest.fn(),
        copy: jest.fn(),
        getPresignedUploadUrl: jest.fn(),
        getPresignedDownloadUrl: jest.fn(),
        initiateMultipartUpload: jest.fn(),
        getPresignedPartUploadUrl: jest.fn(),
        completeMultipartUpload: jest.fn(),
        abortMultipartUpload: jest.fn(),
        listUploadedParts: jest.fn(),
      };

      mockNodeRepo = {
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined as any),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        list: jest.fn(),
        findByBlobId: jest.fn(),
        softDeleteSubtree: jest.fn(),
        restoreSubtree: jest.fn(),
        findSubtreeNodes: jest.fn(),
        findExpiredTrash: jest.fn(),
      };

      mockBlobRepo = {
        findById: jest.fn(),
        findByHash: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findTombstonedBlobs: jest.fn(),
      };

      consumer = new StorageQueueConsumer(
        mockDriver,
        mockNodeRepo,
        mockBlobRepo,
      );
    });

    it('should skip processing if storage node does not exist or is trashed', async () => {
      mockNodeRepo.findById.mockResolvedValue(null);

      const job = {
        id: 'job-1',
        data: {
          fileId: 'non-existent',
          blobId: 'blob-1',
          s3Key: 'blobs/1',
          mimeType: 'image/png',
          filename: 'test.png',
          userId: 'user-1',
        },
      } as Job<StorageProcessingJobData>;

      await consumer.process(job);

      expect(mockDriver.getStream).not.toHaveBeenCalled();
      expect(mockNodeRepo.update).not.toHaveBeenCalled();
    });

    it('should process image files: generate 250x250 webp thumbnail and extract dimensions', async () => {
      // Create a 100x100 test PNG buffer with sharp
      const imageBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      mockDriver.getStream.mockResolvedValue({
        stream: Readable.from(imageBuffer),
        contentLength: imageBuffer.length,
      });

      const node = new StorageNode({
        id: 'node-img',
        name: 'test.png',
        isFolder: false,
        size: BigInt(imageBuffer.length),
        mimeType: 'image/png',
        blobId: 'blob-img-123',
        scope: FileScope.Personal,
        metadata: {},
        authorId: 'user-1',
      });
      mockNodeRepo.findById.mockResolvedValue(node);

      const job = {
        id: 'job-img-1',
        data: {
          fileId: 'node-img',
          blobId: 'blob-img-123',
          s3Key: 'blobs/img-123',
          mimeType: 'image/png',
          filename: 'test.png',
          userId: 'user-1',
        },
      } as Job<StorageProcessingJobData>;

      await consumer.process(job);

      // Verify thumbnail saved
      expect(mockDriver.put).toHaveBeenCalledWith(
        'thumbnails/blob-img-123.webp',
        expect.any(Buffer),
        expect.objectContaining({ mimeType: 'image/webp' }),
      );

      // Verify node metadata updated
      expect(mockNodeRepo.update).toHaveBeenCalledTimes(1);
      expect(node.metadata?.thumbnail).toBe(
        '/api/files/r2/thumbnails%2Fblob-img-123.webp',
      );
      expect(node.metadata?.dimensions).toEqual({
        width: 100,
        height: 100,
        format: 'png',
      });
    });

    it('should process PDF files: extract page count using pdf-lib', async () => {
      // Create a minimal 2-page PDF
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([200, 200]);
      pdfDoc.addPage([200, 200]);
      const pdfBytes = await pdfDoc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      mockDriver.getStream.mockResolvedValue({
        stream: Readable.from(pdfBuffer),
        contentLength: pdfBuffer.length,
      });

      const node = new StorageNode({
        id: 'node-pdf',
        name: 'paper.pdf',
        isFolder: false,
        size: BigInt(pdfBuffer.length),
        mimeType: 'application/pdf',
        blobId: 'blob-pdf-456',
        scope: FileScope.Personal,
        metadata: {},
        authorId: 'user-1',
      });
      mockNodeRepo.findById.mockResolvedValue(node);

      const job = {
        id: 'job-pdf-1',
        data: {
          fileId: 'node-pdf',
          blobId: 'blob-pdf-456',
          s3Key: 'blobs/pdf-456',
          mimeType: 'application/pdf',
          filename: 'paper.pdf',
          userId: 'user-1',
        },
      } as Job<StorageProcessingJobData>;

      await consumer.process(job);

      expect(mockNodeRepo.update).toHaveBeenCalledTimes(1);
      expect(node.metadata?.pageCount).toBe(2);
    });

    it('should process CSV dataset files: extract columns and preview sample rows', async () => {
      const csvData =
        'experiment_id,temperature,pressure,accuracy\nEXP-001,298.15,101.3,0.954\nEXP-002,303.15,102.1,0.968\nEXP-003,308.15,103.0,0.972\n';
      const csvBuffer = Buffer.from(csvData);

      mockDriver.getStream.mockResolvedValue({
        stream: Readable.from(csvBuffer),
        contentLength: csvBuffer.length,
      });

      const node = new StorageNode({
        id: 'node-csv',
        name: 'results.csv',
        isFolder: false,
        size: BigInt(csvBuffer.length),
        mimeType: 'text/csv',
        blobId: 'blob-csv-789',
        scope: FileScope.Personal,
        metadata: {},
        authorId: 'user-1',
      });
      mockNodeRepo.findById.mockResolvedValue(node);

      const job = {
        id: 'job-csv-1',
        data: {
          fileId: 'node-csv',
          blobId: 'blob-csv-789',
          s3Key: 'blobs/csv-789',
          mimeType: 'text/csv',
          filename: 'results.csv',
          userId: 'user-1',
        },
      } as Job<StorageProcessingJobData>;

      await consumer.process(job);

      expect(mockNodeRepo.update).toHaveBeenCalledTimes(1);
      expect(node.metadata?.datasetPreview).toBeDefined();
      expect(node.metadata?.datasetPreview.columns).toEqual([
        'experiment_id',
        'temperature',
        'pressure',
        'accuracy',
      ]);
      expect(node.metadata?.datasetPreview.totalSampledRows).toBe(4);
      expect(node.metadata?.datasetPreview.sampleRows.length).toBe(3);
      expect(node.metadata?.datasetPreview.sampleRows[0]).toEqual([
        'EXP-001',
        '298.15',
        '101.3',
        '0.954',
      ]);
    });
  });
});
