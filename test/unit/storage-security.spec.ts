import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  validateMagicBytes,
  isBlockedExtension,
  sanitizeFilename,
  isDangerousInlineMime,
} from '@/modules/storage/domain/value-objects/file-validator.util';
import { R2Service } from '@/modules/storage/infrastructure/drivers/r2.service';
import { StorageAccessPolicy } from '@/modules/storage/application/policies/storage-access.policy';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { FileScope } from '@/modules/storage/domain/value-objects/file-scope.vo';
import { StreamController } from '@/modules/storage/presentation/controllers/stream.controller';
import { FileDownloadedEvent } from '@/modules/storage/domain/events/file-downloaded.event';
import { Readable } from 'stream';

describe('Storage & File Security Suite', () => {
  describe('File Validator Utility - Magic Bytes & Extension Guard', () => {
    it('should detect and block dangerous executable and script extensions', () => {
      expect(isBlockedExtension('exploit.exe')).toBe(true);
      expect(isBlockedExtension('webshell.php')).toBe(true);
      expect(isBlockedExtension('script.sh')).toBe(true);
      expect(isBlockedExtension('malicious.bat')).toBe(true);
      expect(isBlockedExtension('phishing.html')).toBe(true);
      expect(isBlockedExtension('payload.vbs')).toBe(true);

      // Safe research files
      expect(isBlockedExtension('paper.pdf')).toBe(false);
      expect(isBlockedExtension('figure.png')).toBe(false);
      expect(isBlockedExtension('dataset.csv')).toBe(false);
      expect(isBlockedExtension('citation.bib')).toBe(false);
    });

    it('should sanitize filenames preventing path traversal and special characters', () => {
      expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('..\\..\\secret.env')).toBe('secret.env');
      expect(sanitizeFilename('my paper; rm -rf.pdf')).toBe(
        'my_paper__rm_-rf.pdf',
      );
    });

    it('should reject claimed PDF files that lack valid PDF magic bytes (%PDF-)', () => {
      // Fake PDF that is actually plain text or HTML
      const fakePdfBuffer = Buffer.from(
        '<html><script>alert(1)</script></html>',
      );
      expect(() => {
        validateMagicBytes(fakePdfBuffer, 'application/pdf', 'paper.pdf');
      }).toThrow(BadRequestException);
    });

    it('should accept authentic PDF files with %PDF- signature', () => {
      const realPdfBuffer = Buffer.from('%PDF-1.7 actual pdf content');
      expect(() => {
        validateMagicBytes(realPdfBuffer, 'application/pdf', 'paper.pdf');
      }).not.toThrow();
    });

    it('should reject claimed PNG files that lack valid PNG magic bytes', () => {
      const fakePngBuffer = Buffer.from('not a real png');
      expect(() => {
        validateMagicBytes(fakePngBuffer, 'image/png', 'figure.png');
      }).toThrow(BadRequestException);
    });

    it('should accept authentic PNG files with 0x89PNG header', () => {
      const realPngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
      ]);
      expect(() => {
        validateMagicBytes(realPngBuffer, 'image/png', 'figure.png');
      }).not.toThrow();
    });

    it('should reject Windows PE executables disguised as documents', () => {
      const fakeExecutable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]); // MZ header
      expect(() => {
        validateMagicBytes(
          fakeExecutable,
          'application/octet-stream',
          'doc.bin',
        );
      }).toThrow(BadRequestException);
    });

    it('should reject SVG containing malicious script tags', () => {
      const xssSvg = Buffer.from('<svg><script>alert("xss")</script></svg>');
      expect(() => {
        validateMagicBytes(xssSvg, 'image/svg+xml', 'icon.svg');
      }).toThrow(BadRequestException);
    });

    it('should reject SVG containing active vectors like foreignObject, event handlers, and javascript: links', () => {
      const foreignObjectSvg = Buffer.from(
        '<svg><foreignObject width="100" height="50"><body><div>xss</div></body></foreignObject></svg>',
      );
      expect(() => {
        validateMagicBytes(foreignObjectSvg, 'image/svg+xml', 'icon.svg');
      }).toThrow(BadRequestException);

      const onloadSvg = Buffer.from(
        '<svg onload="alert(document.cookie)"><circle r="10"/></svg>',
      );
      expect(() => {
        validateMagicBytes(onloadSvg, 'image/svg+xml', 'icon.svg');
      }).toThrow(BadRequestException);

      const jsLinkSvg = Buffer.from(
        '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>',
      );
      expect(() => {
        validateMagicBytes(jsLinkSvg, 'image/svg+xml', 'icon.svg');
      }).toThrow(BadRequestException);

      const iframeSvg = Buffer.from(
        '<svg><iframe src="https://attacker.com"></iframe></svg>',
      );
      expect(() => {
        validateMagicBytes(iframeSvg, 'image/svg+xml', 'icon.svg');
      }).toThrow(BadRequestException);
    });

    it('should accept clean and authentic SVG graphics without script vectors', () => {
      const cleanSvg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" stroke="green" fill="yellow"/></svg>',
      );
      expect(() => {
        validateMagicBytes(cleanSvg, 'image/svg+xml', 'diagram.svg');
      }).not.toThrow();
    });

    it('should classify active and scriptable MIME types as dangerous inline MIME', () => {
      expect(isDangerousInlineMime('image/svg+xml')).toBe(true);
      expect(isDangerousInlineMime('text/html')).toBe(true);
      expect(isDangerousInlineMime('text/xml')).toBe(true);
      expect(isDangerousInlineMime('application/xhtml+xml')).toBe(true);
      expect(isDangerousInlineMime('application/javascript')).toBe(true);
      expect(isDangerousInlineMime('text/javascript')).toBe(true);

      // Safe research MIME types
      expect(isDangerousInlineMime('application/pdf')).toBe(false);
      expect(isDangerousInlineMime('image/png')).toBe(false);
      expect(isDangerousInlineMime('image/jpeg')).toBe(false);
      expect(isDangerousInlineMime('text/csv')).toBe(false);
      expect(isDangerousInlineMime('application/json')).toBe(false);
      expect(isDangerousInlineMime(undefined)).toBe(false);
    });
  });

  describe('R2Service - Path Traversal Prevention on Local Fallback', () => {
    let r2Service: R2Service;

    beforeEach(() => {
      const mockConfigService = {
        get: jest.fn().mockReturnValue(''),
      };
      r2Service = new R2Service(mockConfigService as any);
    });

    it('should throw BadRequestException when storage key attempts directory traversal with ..', () => {
      expect(() => {
        r2Service.getLocalFilePath('../../../.env');
      }).toThrow(BadRequestException);

      expect(() => {
        r2Service.getLocalFilePath('uploads/../../passwords.txt');
      }).toThrow(BadRequestException);

      expect(() => {
        r2Service.getLocalFilePath('..\\..\\windows\\system32');
      }).toThrow(BadRequestException);
    });

    it('should safely resolve legitimate keys strictly inside uploads directory', () => {
      const legitimatePath = r2Service.getLocalFilePath(
        'users/user-123/paper.pdf',
      );
      expect(legitimatePath).toContain('uploads');
      expect(legitimatePath).not.toContain('..');
    });
  });

  describe('StorageAccessPolicy - 5-Tier ReBAC & BOLA/IDOR Protection', () => {
    let accessPolicy: StorageAccessPolicy;
    let mockPrisma: any;
    let mockNodeRepo: any;

    beforeEach(() => {
      mockPrisma = {
        fileShare: {
          findUnique: jest.fn(),
        },
        projectMember: {
          findUnique: jest.fn(),
        },
      };
      mockNodeRepo = {
        findById: jest.fn(),
      };
      accessPolicy = new StorageAccessPolicy(mockPrisma, mockNodeRepo);
    });

    it('should throw ForbiddenException when user attempts to access another user private file without permission', async () => {
      const fileId = 'a0000000-0000-4000-8000-000000000001';
      const fileOwnerId = 'owner-user-id';
      const attackerId = 'attacker-user-id';

      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: fileId,
          name: 'private_paper.pdf',
          isFolder: false,
          size: 1024n,
          authorId: fileOwnerId,
          scope: FileScope.Personal,
        }),
      );
      mockPrisma.fileShare.findUnique.mockResolvedValue(null);

      await expect(
        accessPolicy.assertCanAccess(attackerId, fileId, 'read'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow read access when caller is the verified author/owner', async () => {
      const fileId = 'a0000000-0000-4000-8000-000000000001';
      const fileOwnerId = 'owner-user-id';

      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: fileId,
          name: 'my_thesis.pdf',
          isFolder: false,
          size: 2048n,
          authorId: fileOwnerId,
          scope: FileScope.Personal,
        }),
      );

      const node = await accessPolicy.assertCanAccess(
        fileOwnerId,
        fileId,
        'read',
      );
      expect(node).toBeDefined();
      expect(node.id).toBe(fileId);
    });

    it('should allow read access when file is explicitly shared via FileShare ACL', async () => {
      const fileId = 'a0000000-0000-4000-8000-000000000001';
      const collaboratorId = 'collaborator-123';

      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: fileId,
          name: 'shared_dataset.csv',
          isFolder: false,
          size: 4096n,
          authorId: 'principal-investigator',
          scope: FileScope.Personal,
        }),
      );

      mockPrisma.fileShare.findUnique.mockResolvedValue({
        fileId,
        userId: collaboratorId,
        permission: 'view',
      });

      const node = await accessPolicy.assertCanAccess(
        collaboratorId,
        fileId,
        'read',
      );
      expect(node.id).toBe(fileId);

      // But should forbid write when permission is only 'view'
      await expect(
        accessPolicy.assertCanAccess(collaboratorId, fileId, 'write'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow project members to read files within Project Workbench scope', async () => {
      const fileId = 'a0000000-0000-4000-8000-000000000002';
      const projectId = 'project-ai-lab';
      const memberUserId = 'researcher-member';

      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: fileId,
          projectId,
          name: 'project_report.docx',
          isFolder: false,
          size: 8192n,
          authorId: 'pi-leader',
          scope: FileScope.Project,
        }),
      );

      mockPrisma.fileShare.findUnique.mockResolvedValue(null);
      mockPrisma.projectMember.findUnique.mockResolvedValue({
        projectId,
        userId: memberUserId,
        role: 'MEMBER',
      });

      const node = await accessPolicy.assertCanAccess(
        memberUserId,
        fileId,
        'read',
      );
      expect(node.id).toBe(fileId);
    });
  });

  describe('StreamController - Security Headers & Audit Logging', () => {
    let controller: StreamController;
    let mockStreamBinaryUseCase: any;
    let mockR2Service: any;
    let mockNodeRepo: any;
    let mockBlobRepo: any;
    let mockDriver: any;
    let mockEventEmitter: any;

    beforeEach(() => {
      mockStreamBinaryUseCase = { execute: jest.fn() };
      mockR2Service = { getObjectStream: jest.fn() };
      mockNodeRepo = { findById: jest.fn(), list: jest.fn() };
      mockBlobRepo = { findById: jest.fn() };
      mockDriver = { getStream: jest.fn() };
      mockEventEmitter = { emit: jest.fn() };

      controller = new StreamController(
        mockStreamBinaryUseCase,
        mockR2Service,
        mockNodeRepo,
        mockBlobRepo,
        mockDriver,
        mockEventEmitter,
      );
    });

    it('should force attachment and CSP sandbox for dangerous inline MIME types (SVG)', async () => {
      mockStreamBinaryUseCase.execute.mockResolvedValue({
        statusCode: 200,
        mimeType: 'image/svg+xml',
        contentLength: 512,
        filename: 'vector.svg',
        stream: Readable.from(['<svg></svg>']),
      });

      const headers: Record<string, string> = {};
      const mockReq: any = {
        url: '/api/files/test-svg-id/content',
        headers: {},
        query: {},
        ip: '127.0.0.1',
        user: { id: 'user-001' },
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn((key: string, val: any) => {
          headers[key] = val;
          return mockRes;
        }),
        send: jest.fn(),
      };

      await controller.streamFile('test-svg-id', mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(headers['Content-Type']).toBe('image/svg+xml');
      expect(headers['Content-Disposition']).toContain('attachment');
      expect(headers['Content-Security-Policy']).toBe(
        "default-src 'none'; sandbox",
      );
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'file.downloaded',
        expect.any(FileDownloadedEvent),
      );
    });

    it('should serve safe documents inline without sandbox CSP restriction', async () => {
      mockStreamBinaryUseCase.execute.mockResolvedValue({
        statusCode: 200,
        mimeType: 'application/pdf',
        contentLength: 2048,
        filename: 'research_paper.pdf',
        stream: Readable.from(['fake-pdf']),
      });

      const headers: Record<string, string> = {};
      const mockReq: any = {
        url: '/api/files/test-pdf-id/content',
        headers: {},
        query: {},
        ip: '127.0.0.1',
        user: { id: 'user-001' },
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn((key: string, val: any) => {
          headers[key] = val;
          return mockRes;
        }),
        send: jest.fn(),
      };

      await controller.streamFile('test-pdf-id', mockReq, mockRes);

      expect(headers['Content-Type']).toBe('application/pdf');
      expect(headers['Content-Disposition']).toContain('inline');
      expect(headers['Content-Security-Policy']).toBeUndefined();
    });

    it('should force attachment when user accesses /download endpoint', async () => {
      mockStreamBinaryUseCase.execute.mockResolvedValue({
        statusCode: 200,
        mimeType: 'application/pdf',
        contentLength: 2048,
        filename: 'download_paper.pdf',
        stream: Readable.from(['fake-pdf']),
      });

      const headers: Record<string, string> = {};
      const mockReq: any = {
        url: '/api/files/test-pdf-id/download',
        headers: {},
        query: {},
        ip: '127.0.0.1',
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn((key: string, val: any) => {
          headers[key] = val;
          return mockRes;
        }),
        send: jest.fn(),
      };

      await controller.streamFile('test-pdf-id', mockReq, mockRes);

      expect(headers['Content-Disposition']).toContain('attachment');
    });

    it('should block path traversal attempts in streamR2File (SEC-002)', async () => {
      const mockReq: any = {
        url: '/api/files/r2/..%2F..%2Fetc%2Fpasswd',
        headers: {},
        params: { '*': '../../etc/passwd' },
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await controller.streamR2File(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          message: 'Access to restricted storage path is forbidden',
        }),
      );
    });

    it('should block access to sensitive prefixes like backups/ or private/ in streamR2File (SEC-002)', async () => {
      const mockReq: any = {
        url: '/api/files/r2/backups%2Fproject-backup.zip',
        headers: {},
        params: { '*': 'backups/project-backup.zip' },
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await controller.streamR2File(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          message: 'Access to restricted storage path is forbidden',
        }),
      );
    });

    it('should block unauthenticated requests to private research files in streamFile (SEC-004)', async () => {
      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: 'private-doc-id',
          name: 'confidential_research.pdf',
          isFolder: false,
          size: 1024n,
          authorId: 'scientist-1',
          scope: FileScope.Personal,
          metadata: { isPublic: false },
        }),
      );

      const mockAccessPolicy = {
        assertCanAccess: jest.fn(),
      };
      const securedController = new StreamController(
        mockStreamBinaryUseCase,
        mockR2Service,
        mockNodeRepo,
        mockBlobRepo,
        mockDriver,
        mockEventEmitter,
        mockAccessPolicy as any,
      );

      const mockReq: any = {
        url: '/api/files/private-doc-id/content',
        headers: {},
        query: {},
        ip: '127.0.0.1',
        user: undefined, // Unauthenticated
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await securedController.streamFile('private-doc-id', mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          message: 'Authentication required to access private research file',
        }),
      );
    });

    it('should allow unauthenticated requests if the research file is explicitly public (SEC-004)', async () => {
      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: 'public-doc-id',
          name: 'open_access_paper.pdf',
          isFolder: false,
          size: 2048n,
          authorId: 'scientist-1',
          scope: FileScope.Personal,
          metadata: { isPublic: true },
        }),
      );
      mockStreamBinaryUseCase.execute.mockResolvedValue({
        statusCode: 200,
        mimeType: 'application/pdf',
        contentLength: 2048,
        filename: 'open_access_paper.pdf',
        stream: Readable.from(['open-access-content']),
      });

      const mockAccessPolicy = {
        assertCanAccess: jest.fn(),
      };
      const securedController = new StreamController(
        mockStreamBinaryUseCase,
        mockR2Service,
        mockNodeRepo,
        mockBlobRepo,
        mockDriver,
        mockEventEmitter,
        mockAccessPolicy as any,
      );

      const mockReq: any = {
        url: '/api/files/public-doc-id/content',
        headers: {},
        query: {},
        ip: '127.0.0.1',
        user: undefined,
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await securedController.streamFile('public-doc-id', mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockStreamBinaryUseCase.execute).toHaveBeenCalledWith('public-doc-id', undefined);
    });
  });

  describe('StorageAccessPolicy - Extended Edge Cases & Actions (SEC-001)', () => {
    let accessPolicy: StorageAccessPolicy;
    let mockPrisma: any;
    let mockNodeRepo: any;

    beforeEach(() => {
      mockPrisma = {
        fileShare: { findUnique: jest.fn() },
        projectMember: { findUnique: jest.fn() },
      };
      mockNodeRepo = { findById: jest.fn() };
      accessPolicy = new StorageAccessPolicy(mockPrisma, mockNodeRepo);
    });

    it('should forbid "share" action for regular project members without coordinator or owner role', async () => {
      const fileId = 'project-file-01';
      const projectId = 'proj-lab';
      const memberUserId = 'regular-member';

      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: fileId,
          projectId,
          name: 'dataset.csv',
          isFolder: false,
          size: 1024n,
          authorId: 'pi-owner',
          scope: FileScope.Project,
        }),
      );

      mockPrisma.fileShare.findUnique.mockResolvedValue(null);
      mockPrisma.projectMember.findUnique.mockResolvedValue({
        projectId,
        userId: memberUserId,
        role: 'MEMBER',
      });

      await expect(
        accessPolicy.assertCanAccess(memberUserId, fileId, 'share'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow "share" action for project coordinator or owner', async () => {
      const fileId = 'project-file-01';
      const projectId = 'proj-lab';
      const coordinatorUserId = 'coord-user';

      mockNodeRepo.findById.mockResolvedValue(
        new StorageNode({
          id: fileId,
          projectId,
          name: 'dataset.csv',
          isFolder: false,
          size: 1024n,
          authorId: 'pi-owner',
          scope: FileScope.Project,
        }),
      );

      mockPrisma.fileShare.findUnique.mockResolvedValue(null);
      mockPrisma.projectMember.findUnique.mockResolvedValue({
        projectId,
        userId: coordinatorUserId,
        role: 'COORDINATOR',
      });

      const node = await accessPolicy.assertCanAccess(
        coordinatorUserId,
        fileId,
        'share',
      );
      expect(node.id).toBe(fileId);
    });

    it('should allow access to trashed node when allowTrashed is explicitly enabled', async () => {
      const fileId = 'trashed-file-01';
      const ownerId = 'file-owner';

      const trashedNode = new StorageNode({
        id: fileId,
        name: 'old_draft.pdf',
        isFolder: false,
        size: 512n,
        authorId: ownerId,
        scope: FileScope.Personal,
        trashedAt: new Date(),
      });

      mockNodeRepo.findById.mockResolvedValue(trashedNode);

      // Default should throw NotFoundException
      await expect(
        accessPolicy.assertCanAccess(ownerId, fileId, 'delete'),
      ).rejects.toThrow(NotFoundException);

      // With allowTrashed: true, it should succeed
      const node = await accessPolicy.assertCanAccess(
        ownerId,
        fileId,
        'delete',
        { allowTrashed: true },
      );
      expect(node.id).toBe(fileId);
      expect(node.isTrashed()).toBe(true);
    });
  });
});

