import { Readable } from 'node:stream';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import {
  isBlockedExtension,
  isDangerousInlineMime,
  sanitizeFilename,
  validateMagicBytes,
} from '@/modules/files/domain/files.policy';
import { FileDownloadedEvent } from '@/modules/experiments';
import { StreamController } from '@/modules/experiments/controllers/stream.controller';
import { ExperimentsAccessPolicy } from '@/modules/experiments/domain/access.policy';
import { ExperimentNode, FileScope } from '@/modules/experiments/domain/node.domain';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { StreamService } from '@/modules/experiments/services/stream.service';

describe('Experiments & File Security Suite', () => {
  describe('File Policy - Magic Bytes, Extensions, Filenames & Dangerous MIMEs', () => {
    it('blocks executable/script extensions while allowing safe research files and sanitizing filenames', () => {
      for (const bad of [
        'exploit.exe',
        'webshell.php',
        'script.sh',
        'malicious.bat',
        'phishing.html',
        'payload.vbs',
      ]) {
        expect(isBlockedExtension(bad)).toBe(true);
      }
      for (const safe of [
        'paper.pdf',
        'figure.png',
        'dataset.csv',
        'citation.bib',
      ]) {
        expect(isBlockedExtension(safe)).toBe(false);
      }

      expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('..\\..\\secret.env')).toBe('secret.env');
      expect(sanitizeFilename('my paper; rm -rf.pdf')).toBe(
        'my_paper__rm_-rf.pdf',
      );
    });

    it('validates PDF/PNG/PE magic bytes and blocks XSS vectors in SVG uploads', () => {
      expect(() =>
        validateMagicBytes(
          Buffer.from('<html><script>alert(1)</script></html>'),
          'application/pdf',
          'paper.pdf',
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        validateMagicBytes(
          Buffer.from('%PDF-1.7 actual pdf content'),
          'application/pdf',
          'paper.pdf',
        ),
      ).not.toThrow();

      expect(() =>
        validateMagicBytes(Buffer.from('not a real png'), 'image/png', 'fig.png'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateMagicBytes(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
          'image/png',
          'fig.png',
        ),
      ).not.toThrow();

      expect(() =>
        validateMagicBytes(
          Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
          'application/octet-stream',
          'doc.bin',
        ),
      ).toThrow(BadRequestException);

      for (const maliciousSvg of [
        '<svg><script>alert("xss")</script></svg>',
        '<svg><foreignObject width="100" height="50"><body><div>xss</div></body></foreignObject></svg>',
        '<svg onload="alert(document.cookie)"><circle r="10"/></svg>',
        '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>',
        '<svg><iframe src="https://attacker.com"></iframe></svg>',
      ]) {
        expect(() =>
          validateMagicBytes(
            Buffer.from(maliciousSvg),
            'image/svg+xml',
            'icon.svg',
          ),
        ).toThrow(BadRequestException);
      }

      expect(() =>
        validateMagicBytes(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>',
          ),
          'image/svg+xml',
          'diagram.svg',
        ),
      ).not.toThrow();

      for (const dangerous of [
        'image/svg+xml',
        'text/html',
        'text/xml',
        'application/xhtml+xml',
        'application/javascript',
        'text/javascript',
      ]) {
        expect(isDangerousInlineMime(dangerous)).toBe(true);
      }
      for (const safe of [
        'application/pdf',
        'image/png',
        'image/jpeg',
        'text/csv',
        'application/json',
        undefined,
      ]) {
        expect(isDangerousInlineMime(safe)).toBe(false);
      }
    });

    it('prevents directory traversal on LocalStorageAdapter.resolveFilePath', () => {
      const localDriver = new LocalStorageAdapter('./test-storage');
      for (const badKey of [
        '../../../.env',
        'uploads/../../passwords.txt',
        '..\\..\\windows\\system32',
      ]) {
        expect(() => localDriver.resolveFilePath(badKey)).toThrow(
          BadRequestException,
        );
      }
      const ok = localDriver.resolveFilePath('users/user-123/paper.pdf');
      expect(ok).toContain('test-storage');
      expect(ok).not.toContain('..');
    });
  });

  describe('ExperimentsAccessPolicy - 5-Tier ReBAC & BOLA/IDOR Protection', () => {
    let accessPolicy: ExperimentsAccessPolicy;
    let mockNodeRepo: jest.Mocked<NodeRepository>;

    beforeEach(() => {
      mockNodeRepo = fromPartial<jest.Mocked<NodeRepository>>({
        findById: jest.fn(),
        findUserSharesForFiles: jest.fn().mockResolvedValue([]),
        findProjectMemberRole: jest.fn().mockResolvedValue(null),
        findSpaceOwnerId: jest.fn().mockResolvedValue(null),
      });
      accessPolicy = new ExperimentsAccessPolicy(mockNodeRepo);
    });

    it('enforces owner, FileShare view/write ACLs, Project member read vs coordinator share, and allowTrashed', async () => {
      const personalFile = new ExperimentNode({
        id: 'a0000000-0000-4000-8000-000000000001',
        name: 'private_paper.pdf',
        isFolder: false,
        size: 1024n,
        authorId: 'owner-user',
        scope: FileScope.Personal,
      });
      mockNodeRepo.findById.mockResolvedValue(personalFile);

      await expect(
        accessPolicy.assertCanAccess('attacker-user', personalFile.id, 'read'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        accessPolicy.assertCanAccess('owner-user', personalFile.id, 'read'),
      ).resolves.toMatchObject({ id: personalFile.id });

      // FileShare 'view' grants read, denies write
      mockNodeRepo.findUserSharesForFiles.mockResolvedValueOnce([
        { permission: 'view' } as never,
      ]);
      await expect(
        accessPolicy.assertCanAccess('collab-123', personalFile.id, 'read'),
      ).resolves.toMatchObject({ id: personalFile.id });

      mockNodeRepo.findUserSharesForFiles.mockResolvedValueOnce([
        { permission: 'view' } as never,
      ]);
      await expect(
        accessPolicy.assertCanAccess('collab-123', personalFile.id, 'write'),
      ).rejects.toThrow(ForbiddenException);

      // Project member can read, cannot share; coordinator can share
      const projectFile = new ExperimentNode({
        id: 'a0000000-0000-4000-8000-000000000002',
        projectId: 'proj-lab',
        name: 'dataset.csv',
        isFolder: false,
        size: 8192n,
        authorId: 'pi-owner',
        scope: FileScope.Project,
      });
      mockNodeRepo.findById.mockResolvedValue(projectFile);
      mockNodeRepo.findProjectMemberRole.mockResolvedValue('MEMBER');

      await expect(
        accessPolicy.assertCanAccess('member-user', projectFile.id, 'read'),
      ).resolves.toMatchObject({ id: projectFile.id });
      await expect(
        accessPolicy.assertCanAccess('member-user', projectFile.id, 'share'),
      ).rejects.toThrow(ForbiddenException);

      mockNodeRepo.findProjectMemberRole.mockResolvedValue('COORDINATOR');
      await expect(
        accessPolicy.assertCanAccess('coord-user', projectFile.id, 'share'),
      ).resolves.toMatchObject({ id: projectFile.id });

      // Trashed node requires explicit allowTrashed
      const trashedNode = new ExperimentNode({
        id: 'trashed-file-01',
        name: 'old_draft.pdf',
        isFolder: false,
        size: 512n,
        authorId: 'owner-user',
        scope: FileScope.Personal,
        trashedAt: new Date(),
      });
      mockNodeRepo.findById.mockResolvedValue(trashedNode);

      await expect(
        accessPolicy.assertCanAccess('owner-user', trashedNode.id, 'delete'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        accessPolicy.assertCanAccess('owner-user', trashedNode.id, 'delete', {
          allowTrashed: true,
        }),
      ).resolves.toMatchObject({ id: trashedNode.id });
    });
  });

  describe('StreamController - Security Headers, ETag 304 & SEC-004 Auth', () => {
    let controller: StreamController;
    let mockStreamService: jest.Mocked<StreamService>;
    let mockEventEmitter: jest.Mocked<EventEmitter2>;

    const makeRes = () => {
      const headers: Record<string, string> = {};
      let statusCode = 0;
      let sentBody: unknown;
      const res: FastifyReply = fromPartial<FastifyReply>({
        status: jest.fn((c: number) => {
          statusCode = c;
          return res;
        }),
        header: jest.fn((key: string, val: unknown) => {
          headers[key] = String(val);
          return res;
        }),
        send: jest.fn((b?: unknown) => {
          sentBody = b;
          return res;
        }),
      });
      return { res, headers, getStatus: () => statusCode, getBody: () => sentBody };
    };

    beforeEach(() => {
      mockStreamService = fromPartial<jest.Mocked<StreamService>>({
        stream: jest.fn(),
        verifyReadAccess: jest.fn().mockResolvedValue(undefined),
      });
      mockEventEmitter = fromPartial<jest.Mocked<EventEmitter2>>({
        emit: jest.fn(),
      });
      controller = new StreamController(mockStreamService, mockEventEmitter);
    });

    it('forces attachment + CSP sandbox for SVG, serves PDF inline, forces attachment on /download, and returns 304 on matching ETag', async () => {
      mockStreamService.stream.mockResolvedValueOnce(
        fromPartial({
          statusCode: 200,
          mimeType: 'image/svg+xml',
          contentLength: 512,
          filename: 'vector.svg',
          stream: Readable.from(['<svg></svg>']),
        }),
      );
      const svgOut = makeRes();
      await controller.streamFile(
        'test-svg-id',
        fromPartial<FastifyRequest & { user?: { id: string } }>({
          url: '/api/v1/experiments/files/test-svg-id/content',
          headers: {},
          query: {},
          ip: '127.0.0.1',
          user: { id: 'user-001' },
        }),
        svgOut.res,
      );
      expect(svgOut.getStatus()).toBe(200);
      expect(svgOut.headers['Content-Disposition']).toContain('attachment');
      expect(svgOut.headers['Content-Security-Policy']).toBe(
        "default-src 'none'; sandbox",
      );
      expect(svgOut.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'file.downloaded',
        expect.any(FileDownloadedEvent),
      );

      // Safe PDF inline
      const mockEtag =
        '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"';
      mockStreamService.stream.mockResolvedValue(
        fromPartial({
          statusCode: 200,
          mimeType: 'application/pdf',
          contentLength: 2048,
          filename: 'paper.pdf',
          stream: Readable.from(['%PDF-1.7']),
          etag: mockEtag,
        }),
      );
      const pdfInline = makeRes();
      await controller.streamFile(
        'test-pdf-id',
        fromPartial<FastifyRequest & { user?: { id: string } }>({
          url: '/api/v1/experiments/files/test-pdf-id/content',
          headers: {},
          query: {},
          ip: '127.0.0.1',
          user: { id: 'user-001' },
        }),
        pdfInline.res,
      );
      expect(pdfInline.headers['Content-Disposition']).toContain('inline');
      expect(pdfInline.headers['Content-Security-Policy']).toBeUndefined();

      // /download forces attachment
      const pdfDl = makeRes();
      await controller.streamFile(
        'test-pdf-id',
        fromPartial<FastifyRequest>({
          url: '/api/v1/experiments/files/test-pdf-id/download',
          headers: {},
          query: {},
          ip: '127.0.0.1',
        }),
        pdfDl.res,
      );
      expect(pdfDl.headers['Content-Disposition']).toContain('attachment');

      // Matching If-None-Match -> 304 Not Modified
      const cached = makeRes();
      await controller.streamFile(
        'test-pdf-id',
        fromPartial<FastifyRequest & { user?: { id: string } }>({
          url: '/api/v1/experiments/files/test-pdf-id/content',
          headers: { 'if-none-match': mockEtag },
          query: {},
          ip: '127.0.0.1',
          user: { id: 'user-001' },
        }),
        cached.res,
      );
      expect(cached.getStatus()).toBe(304);
      expect(cached.headers['ETag']).toBe(mockEtag);
    });

    it('blocks unauthenticated access to private files (403) while allowing explicitly public files (SEC-004)', async () => {
      mockStreamService.verifyReadAccess.mockRejectedValueOnce(
        new ForbiddenException(
          'Authentication required to access private research file',
        ),
      );
      const privOut = makeRes();
      await controller.streamFile(
        'private-doc-id',
        fromPartial<FastifyRequest>({
          url: '/api/v1/experiments/files/private-doc-id/content',
          headers: {},
          query: {},
          ip: '127.0.0.1',
        }),
        privOut.res,
      );
      expect(privOut.getStatus()).toBe(403);

      mockStreamService.verifyReadAccess.mockResolvedValueOnce(undefined);
      mockStreamService.stream.mockResolvedValueOnce(
        fromPartial({
          statusCode: 200,
          mimeType: 'application/pdf',
          contentLength: 2048,
          filename: 'open_access.pdf',
          stream: Readable.from(['open-access']),
        }),
      );
      const pubOut = makeRes();
      await controller.streamFile(
        'public-doc-id',
        fromPartial<FastifyRequest>({
          url: '/api/v1/experiments/files/public-doc-id/content',
          headers: {},
          query: {},
          ip: '127.0.0.1',
        }),
        pubOut.res,
      );
      expect(pubOut.getStatus()).toBe(200);
    });
  });
});
