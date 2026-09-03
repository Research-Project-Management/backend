import { Test, TestingModule } from '@nestjs/testing';
import { FileController } from '@/modules/storage/file/file.controller';
import { FileService } from '@/modules/storage/file/file.service';
import { StorageAdapter } from '@/modules/storage/storage.adapter';
import { PrismaService } from '@/core/database/prisma.service';
import { R2Service } from '@/modules/storage/r2/r2.service';
import {
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';

describe('File Content Streaming & Storage Port Unit Tests', () => {
  let fileController: FileController;
  let fileService: jest.Mocked<any>;
  let storageAdapter: StorageAdapter;
  let prisma: jest.Mocked<any>;
  let r2Service: jest.Mocked<any>;

  beforeEach(async () => {
    fileService = {
      getFile: jest.fn(),
      getFileContentStream: jest.fn(),
      getR2Stream: jest.fn(),
    };

    prisma = {
      file: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      workspace: {
        findFirst: jest.fn(),
      },
    };

    r2Service = {
      getObjectStream: jest.fn(),
      getObjectRangeStream: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FileController],
      providers: [
        { provide: FileService, useValue: fileService },
        StorageAdapter,
        { provide: PrismaService, useValue: prisma },
        { provide: R2Service, useValue: r2Service },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    fileController = module.get<FileController>(FileController);
    storageAdapter = module.get<StorageAdapter>(StorageAdapter);
  });

  describe('StorageAdapter.readOwnedFile', () => {
    it('accepts object contract { workspaceId, fileId } and returns binary buffer and canonical contentUrl', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.5 test document');
      prisma.file.findUnique.mockResolvedValueOnce({
        id: 'file-123',
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        size: pdfBuffer.length,
        url: '/api/files/r2/ws-1/file-123.pdf',
        workspaceId: 'ws-1',
        trashedAt: null,
      });

      r2Service.getObjectStream.mockResolvedValueOnce({
        Body: Readable.from(pdfBuffer),
        ContentType: 'application/pdf',
        ContentLength: pdfBuffer.length,
      });

      const output = await storageAdapter.readOwnedFile({
        workspaceId: 'ws-1',
        fileId: 'file-123',
      });

      expect(output.fileId).toBe('file-123');
      expect(output.filename).toBe('paper.pdf');
      expect(output.mimeType).toBe('application/pdf');
      expect(output.buffer.toString('ascii', 0, 5)).toBe('%PDF-');
      expect(output.contentUrl).toBe('/api/files/file-123/content');
    });

    it('rejects cross-workspace file access with ForbiddenException', async () => {
      prisma.file.findUnique.mockResolvedValueOnce({
        id: 'file-123',
        filename: 'paper.pdf',
        workspaceId: 'ws-other',
        trashedAt: null,
      });
      prisma.workspace.findFirst.mockResolvedValueOnce(null);

      await expect(
        storageAdapter.readOwnedFile({
          workspaceId: 'ws-1',
          fileId: 'file-123',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects trashed files with NotFoundException', async () => {
      prisma.file.findUnique.mockResolvedValueOnce({
        id: 'file-123',
        filename: 'paper.pdf',
        workspaceId: 'ws-1',
        trashedAt: new Date(),
      });

      await expect(
        storageAdapter.readOwnedFile({
          workspaceId: 'ws-1',
          fileId: 'file-123',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('FileController.getFileContent', () => {
    it('streams binary PDF content with application/pdf Content-Type, inline disposition and security headers', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 test stream');
      fileService.getFileContentStream.mockResolvedValueOnce({
        stream: Readable.from(pdfBuffer),
        contentType: 'application/pdf',
        contentLength: pdfBuffer.length,
        filename: 'attention.pdf',
        statusCode: 200,
      });

      const headers: Record<string, string | number> = {};
      let statusCode = 200;
      const res: any = {
        status: jest.fn().mockImplementation((code: number) => {
          statusCode = code;
          return res;
        }),
        header: jest.fn().mockImplementation((name: string, val: any) => {
          headers[name] = val;
          return res;
        }),
        send: jest.fn().mockImplementation((body: any) => body),
      };

      const req: any = {
        headers: {},
      };

      await (fileController as any).getFileContent(
        'file-123',
        'user-1',
        req,
        res,
      );

      expect(res.header).toHaveBeenCalledWith(
        'Content-Type',
        'application/pdf',
      );
      expect(res.header).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('inline; filename="attention.pdf"'),
      );
      expect(res.header).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
      expect(res.header).toHaveBeenCalledWith(
        'X-Content-Type-Options',
        'nosniff',
      );
      expect(res.header).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-cache, no-transform',
      );
      expect(statusCode).toBe(200);
    });

    it('forces attachment disposition for untrusted MIME types (e.g. HTML/SVG/JSON)', async () => {
      fileService.getFileContentStream.mockResolvedValueOnce({
        stream: Readable.from(Buffer.from('<html>evil</html>')),
        contentType: 'text/html',
        contentLength: 17,
        filename: 'page.html',
        statusCode: 200,
      });

      const headers: Record<string, string | number> = {};
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.header = jest.fn().mockImplementation((name: string, val: any) => {
        headers[name] = val;
        return res;
      });
      res.send = jest.fn().mockImplementation((body: any) => body);

      await (fileController as any).getFileContent(
        'file-html',
        'user-1',
        { headers: {} },
        res,
      );

      expect(headers['Content-Disposition']).toContain(
        'attachment; filename="page.html"',
      );
    });

    it('metadata endpoint getFile still returns JSON metadata', async () => {
      fileService.getFile.mockResolvedValueOnce({
        id: 'file-123',
        filename: 'paper.pdf',
        size: 1024,
        mimeType: 'application/pdf',
      });

      const result = await fileController.getFile('file-123', 'user-1');
      expect(result).toEqual({
        id: 'file-123',
        filename: 'paper.pdf',
        size: 1024,
        mimeType: 'application/pdf',
      });
    });
  });
});
