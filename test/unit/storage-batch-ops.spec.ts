import {
  ZipPackager,
  crc32,
} from '@/modules/storage/infrastructure/utils/zip-packager';
import { DriveController } from '@/modules/storage/presentation/controllers/drive.controller';
import { StreamController } from '@/modules/storage/presentation/controllers/stream.controller';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { Readable } from 'node:stream';
import { HttpStatus } from '@nestjs/common';

describe('Storage Batch Operations & ZIP Packager Suite', () => {
  describe('ZipPackager Utility', () => {
    it('should compute valid CRC-32 checksums', () => {
      const data = Buffer.from('123456789');
      // Standard known CRC-32 of '123456789' is 0xCBF43926 (3421780262)
      expect(crc32(data)).toBe(0xcbf43926);
    });

    it('should package multiple files into a valid PKZIP binary', () => {
      const zip = new ZipPackager();
      const csvContent = Buffer.from(
        'id,name,value\n1,Alpha,100\n2,Beta,200\n',
      );
      const pyContent = Buffer.from('def run_experiment():\n    return 42\n');

      zip.addFile('experiments/results.csv', csvContent);
      zip.addFile('scripts/train.py', pyContent);

      const buffer = zip.build();

      expect(buffer.length).toBeGreaterThan(0);

      // Check PKZIP Local File Header signature (0x04034b50 -> 0x50, 0x4b, 0x03, 0x04)
      expect(buffer[0]).toBe(0x50);
      expect(buffer[1]).toBe(0x4b);
      expect(buffer[2]).toBe(0x03);
      expect(buffer[3]).toBe(0x04);

      // Check that relative filenames are embedded in the binary
      expect(buffer.toString('utf8')).toContain('experiments/results.csv');
      expect(buffer.toString('utf8')).toContain('scripts/train.py');

      // Check End of Central Directory signature (0x06054b50 -> 0x50, 0x4b, 0x05, 0x06)
      const eocdIndex = buffer.lastIndexOf(
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      );
      expect(eocdIndex).toBeGreaterThan(-1);

      // Verify entry count in EOCD (offset 8 and 10 in 22-byte EOCD)
      expect(buffer.readUInt16LE(eocdIndex + 8)).toBe(2);
      expect(buffer.readUInt16LE(eocdIndex + 10)).toBe(2);
    });
  });

  describe('DriveController Batch Move', () => {
    let driveController: DriveController;
    let mockListUseCase: any;
    let mockMoveUseCase: any;
    let mockSoftDeleteUseCase: any;
    let mockNodeRepo: any;

    beforeEach(() => {
      mockListUseCase = { execute: jest.fn() };
      mockMoveUseCase = { execute: jest.fn().mockResolvedValue(undefined) };
      mockSoftDeleteUseCase = { execute: jest.fn() };
      mockNodeRepo = {
        findById: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      };

      driveController = new DriveController(
        mockListUseCase,
        mockMoveUseCase,
        mockSoftDeleteUseCase,
        mockNodeRepo,
      );
    });

    it('should move multiple items to a target parent folder', async () => {
      const res = await driveController.batchMove({
        ids: ['file-1', 'file-2', 'file-3'],
        targetFolderId: 'folder-dest-99',
      });

      expect(res.success).toBe(true);
      expect(res.count).toBe(3);
      expect(mockMoveUseCase.execute).toHaveBeenCalledTimes(3);
      expect(mockMoveUseCase.execute).toHaveBeenCalledWith(
        'file-1',
        'folder-dest-99',
      );
      expect(mockMoveUseCase.execute).toHaveBeenCalledWith(
        'file-2',
        'folder-dest-99',
      );
      expect(mockMoveUseCase.execute).toHaveBeenCalledWith(
        'file-3',
        'folder-dest-99',
      );
    });
  });

  describe('StreamController Bulk Download ZIP', () => {
    let streamController: StreamController;
    let mockStreamUseCase: any;
    let mockR2Service: any;
    let mockNodeRepo: any;
    let mockBlobRepo: any;
    let mockDriver: any;
    let mockReply: any;

    beforeEach(() => {
      mockStreamUseCase = { execute: jest.fn() };
      mockR2Service = { getObjectStream: jest.fn() };
      mockNodeRepo = {
        findById: jest.fn().mockImplementation(async (id: string) => {
          if (id === 'file-csv') {
            return new StorageNode({
              id: 'file-csv',
              authorId: 'user-1',
              name: 'dataset.csv',
              isFolder: false,
              size: 50n,
              blobId: 'blob-csv-1',
            });
          }
          return null;
        }),
        list: jest.fn(),
      };
      mockBlobRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'blob-csv-1',
          s3Key: { value: () => 'blobs/dataset.csv' },
        }),
      };
      mockDriver = {
        getStream: jest.fn().mockResolvedValue({
          stream: Readable.from([Buffer.from('col1,col2\nval1,val2\n')]),
        }),
      };

      const headersSet = new Map<string, string>();
      let responseBody: any = null;
      let statusCode = 200;

      mockReply = {
        status: jest.fn().mockImplementation((code: number) => {
          statusCode = code;
          return mockReply;
        }),
        header: jest.fn().mockImplementation((key: string, val: any) => {
          headersSet.set(key, String(val));
          return mockReply;
        }),
        send: jest.fn().mockImplementation((body: any) => {
          responseBody = body;
          return { statusCode, headers: headersSet, body: responseBody };
        }),
      };

      streamController = new StreamController(
        mockStreamUseCase,
        mockR2Service,
        mockNodeRepo,
        mockBlobRepo,
        mockDriver,
        { emit: jest.fn() } as any,
      );
    });

    it('should stream a single packaged ZIP archive containing selected files', async () => {
      await streamController.bulkDownloadGet('file-csv', mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(mockReply.header).toHaveBeenCalledWith(
        'Content-Type',
        'application/zip',
      );
      expect(mockReply.send).toHaveBeenCalled();

      const [sentBuffer] = mockReply.send.mock.calls[0];
      expect(Buffer.isBuffer(sentBuffer)).toBe(true);
      expect(sentBuffer.toString('utf8')).toContain('dataset.csv');
    });
  });
});
