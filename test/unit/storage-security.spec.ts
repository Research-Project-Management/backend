import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { validateMagicBytes, isBlockedExtension, sanitizeFilename } from '@/modules/storage/file/utils/file-validator.util';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { StorageAdapter } from '@/modules/storage/storage.adapter';
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
      expect(sanitizeFilename('my paper; rm -rf.pdf')).toBe('my_paper__rm_-rf.pdf');
    });

    it('should reject claimed PDF files that lack valid PDF magic bytes (%PDF-)', () => {
      // Fake PDF that is actually plain text or HTML
      const fakePdfBuffer = Buffer.from('<html><script>alert(1)</script></html>');
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
      const realPngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(() => {
        validateMagicBytes(realPngBuffer, 'image/png', 'figure.png');
      }).not.toThrow();
    });

    it('should reject Windows PE executables disguised as documents', () => {
      const fakeExecutable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]); // MZ header
      expect(() => {
        validateMagicBytes(fakeExecutable, 'application/octet-stream', 'doc.bin');
      }).toThrow(BadRequestException);
    });

    it('should reject SVG containing malicious script tags', () => {
      const xssSvg = Buffer.from('<svg><script>alert("xss")</script></svg>');
      expect(() => {
        validateMagicBytes(xssSvg, 'image/svg+xml', 'icon.svg');
      }).toThrow(BadRequestException);
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
      const legitimatePath = r2Service.getLocalFilePath('users/user-123/paper.pdf');
      expect(legitimatePath).toContain('uploads');
      expect(legitimatePath).not.toContain('..');
    });
  });

  describe('StorageAdapter - BOLA / IDOR Authorization Protection', () => {
    let storageAdapter: StorageAdapter;
    let mockPrisma: any;
    let mockR2Service: any;

    beforeEach(() => {
      mockPrisma = {
        file: {
          findUnique: jest.fn(),
        },
      };
      mockR2Service = {
        getObjectStream: jest.fn().mockResolvedValue({
          Body: Readable.from([Buffer.from('%PDF-1.7 sample data')]),
        }),
      };
      storageAdapter = new StorageAdapter(mockPrisma, mockR2Service);
    });

    it('should throw ForbiddenException when a user attempts to read another user file without permission', async () => {
      const fileId = 'a0000000-0000-4000-8000-000000000001';
      const fileOwnerId = 'owner-user-id';
      const attackerId = 'attacker-user-id';

      mockPrisma.file.findUnique.mockResolvedValue({
        id: fileId,
        authorId: fileOwnerId,
        trashedAt: null,
        key: 'users/owner/uploads/test.pdf',
        sharedWith: [],
        linkedToType: 'Personal',
        linkedToId: fileOwnerId,
      });

      await expect(
        storageAdapter.readOwnedFile({
          fileId,
          userId: attackerId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow read access when caller is the verified file owner', async () => {
      const fileId = 'a0000000-0000-4000-8000-000000000001';
      const fileOwnerId = 'owner-user-id';

      mockPrisma.file.findUnique.mockResolvedValue({
        id: fileId,
        authorId: fileOwnerId,
        trashedAt: null,
        url: '/api/files/r2/users/owner/uploads/test.pdf',
        key: 'users/owner/uploads/test.pdf',
        sharedWith: [],
        linkedToType: 'Personal',
        linkedToId: fileOwnerId,
      });

      const result = await storageAdapter.readOwnedFile({
        fileId,
        userId: fileOwnerId,
      });

      expect(result).toBeDefined();
      expect(result.fileId).toBe(fileId);
    });
  });
});
