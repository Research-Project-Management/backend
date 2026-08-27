import { validateExternalUrl } from '@/modules/library/legacy/translation/utils/translation.util';
import {
  validatePdfBuffer,
  FileSecurityValidator,
} from '@/modules/library/legacy/attachments/utils/attachments.util';

describe('SSRF Guard & File Security (Ingestion & Attachments)', () => {
  let fileSecurity: FileSecurityValidator;

  beforeEach(() => {
    fileSecurity = new FileSecurityValidator();
  });

  describe('SSRF Protection (OWASP Top 10 via translation.util)', () => {
    it('should detect private IPv4 ranges as unsafe', () => {
      expect(validateExternalUrl('http://127.0.0.1/status').isSafe).toBe(false);
      expect(validateExternalUrl('http://169.254.169.254/latest').isSafe).toBe(
        false,
      );
      expect(validateExternalUrl('http://10.0.0.1/admin').isSafe).toBe(false);
      expect(validateExternalUrl('http://172.16.0.1/').isSafe).toBe(false);
      expect(validateExternalUrl('http://192.168.1.1/').isSafe).toBe(false);

      // Public Unicast IPs should be safe
      expect(
        validateExternalUrl('https://api.crossref.org/works/10.1000/182')
          .isSafe,
      ).toBe(true);
    });

    it('should detect private and loopback IPv6 addresses as unsafe', () => {
      expect(validateExternalUrl('http://[::1]/').isSafe).toBe(false);
    });

    it('should reject local and internal hostnames directly', () => {
      expect(validateExternalUrl('http://localhost/admin').isSafe).toBe(false);
      expect(
        validateExternalUrl('http://instance.internal/metadata').isSafe,
      ).toBe(false);
    });

    it('should reject unsupported protocols (e.g. file:, ftp:, gopher:)', () => {
      expect(validateExternalUrl('file:///etc/passwd').isSafe).toBe(false);
      expect(validateExternalUrl('ftp://127.0.0.1:6379').isSafe).toBe(false);
    });
  });

  describe('File Magic Bytes & SHA-256 Integrity', () => {
    it('should validate valid PDF magic bytes (%PDF-)', () => {
      const validPdfBuffer = Buffer.from([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
      ]);
      const result = validatePdfBuffer(validPdfBuffer);

      expect(result.isValid).toBe(true);
      expect(result.detectedMime).toBe('application/pdf');
      expect(result.sizeBytes).toBe(validPdfBuffer.length);
    });

    it('should reject file when magic bytes mismatch declared MIME type', () => {
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const result = validatePdfBuffer(pngBuffer);
      expect(result.isValid).toBe(false);
    });

    it('should reject file when size exceeds threshold', () => {
      const hugeBuffer = Buffer.alloc(10);
      const result = validatePdfBuffer(hugeBuffer, 5);
      expect(result.isValid).toBe(false);
    });
  });
});
