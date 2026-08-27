import { FileSecurityValidator } from '@/modules/library/legacy/attachments/utils/attachments.util';
import { UrlSecurityValidator } from '@/modules/library/legacy/translation/utils/translation.util';

describe('Phase 10: Security & Production Hardening', () => {
  describe('FileSecurityValidator (MIME & Magic Bytes Safety)', () => {
    let validator: FileSecurityValidator;

    beforeEach(() => {
      validator = new FileSecurityValidator();
    });

    it('accepts valid PDF buffer with %PDF- header', () => {
      const validPdfBuffer = Buffer.from(
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF',
      );
      const res = validator.validatePdfBuffer(validPdfBuffer);

      expect(res.isValid).toBe(true);
      expect(res.detectedMime).toBe('application/pdf');
    });

    it('rejects buffers missing PDF magic bytes', () => {
      const plainText = Buffer.from('Hello world this is just text');
      const res = validator.validatePdfBuffer(plainText);

      expect(res.isValid).toBe(false);
      expect(res.error).toContain('valid PDF magic bytes');
    });

    it('rejects Windows PE/MZ executables pretending to be PDFs', () => {
      const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]); // MZ header
      const res = validator.validatePdfBuffer(exeBuffer);

      expect(res.isValid).toBe(false);
      expect(res.error).toContain('Windows PE/MZ executable');
    });

    it('rejects active script polyglots', () => {
      const polyglot = Buffer.from(
        '%PDF-1.4\n<script>alert("xss")</script>\n%%EOF',
      );
      const res = validator.validatePdfBuffer(polyglot);

      expect(res.isValid).toBe(false);
      expect(res.error).toContain('active script polyglot');
    });
  });

  describe('UrlSecurityValidator (SSRF Prevention & DNS Validation)', () => {
    let validator: UrlSecurityValidator;

    beforeEach(() => {
      validator = new UrlSecurityValidator();
    });

    it('allows legitimate public HTTP/HTTPS URLs', () => {
      const res = validator.validateExternalUrl(
        'https://api.crossref.org/works/10.1000/182',
      );
      expect(res.isSafe).toBe(true);
      expect(res.normalizedUrl).toBe(
        'https://api.crossref.org/works/10.1000/182',
      );
    });

    it('blocks non-HTTP protocols (ftp, file, gopher)', () => {
      expect(
        validator.validateExternalUrl('ftp://ftp.example.com').isSafe,
      ).toBe(false);
      expect(validator.validateExternalUrl('file:///etc/passwd').isSafe).toBe(
        false,
      );
    });

    it('blocks localhost and loopback IPv4', () => {
      const resLocal = validator.validateExternalUrl(
        'http://localhost:8080/admin',
      );
      expect(resLocal.isSafe).toBe(false);

      const resIp = validator.validateExternalUrl('http://127.0.0.1:3000/keys');
      expect(resIp.isSafe).toBe(false);
    });

    it('blocks private network IP ranges (10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12)', () => {
      expect(
        validator.validateExternalUrl('http://10.0.0.1/status').isSafe,
      ).toBe(false);
      expect(
        validator.validateExternalUrl('http://192.168.1.50:5432/').isSafe,
      ).toBe(false);
      expect(validator.validateExternalUrl('http://172.20.0.1/').isSafe).toBe(
        false,
      );
    });

    it('blocks Cloud Metadata IP (169.254.169.254)', () => {
      const res = validator.validateExternalUrl(
        'http://169.254.169.254/latest/meta-data/',
      );
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain('SSRF Violation');
    });
  });
});
