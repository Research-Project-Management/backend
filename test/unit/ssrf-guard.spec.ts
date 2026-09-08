import { BadRequestException, ForbiddenException } from '@nestjs/common';

jest.mock('jsdom', () => ({
  JSDOM: jest.fn().mockImplementation((html, options) => ({
    window: {
      document: {
        title: 'Safe Research Paper',
        body: {
          textContent: 'quantum computing',
          innerHTML: '<p>quantum computing</p>',
        },
      },
    },
  })),
}));

jest.mock('dompurify', () => () => ({
  sanitize: (str: string) =>
    str
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ''),
}));

jest.mock('@mozilla/readability', () => ({
  Readability: jest.fn().mockImplementation(() => ({
    parse: () => ({
      title: 'Quantum Error Correction',
      byline: 'Dr. Physicist',
      excerpt: 'Summary of article',
      siteName: 'arxiv.org',
      textContent: 'This is a safe academic article about quantum computing.',
      content:
        '<p>This is a safe academic article about quantum computing.</p>',
    }),
  })),
}));

import { SsrfGuardService } from '@/modules/library/common/services/ssrf-guard.service';
import { WebSnapshotService } from '@/modules/library/attachments/services/web-snapshot.service';
import { AttachmentsService } from '@/modules/library/attachments/attachments.service';

describe('P1 SSRF Protection & WebSnapshot Hardening', () => {
  let ssrfGuard: SsrfGuardService;
  let webSnapshotService: WebSnapshotService;
  let mockAttachmentsService: any;

  beforeEach(() => {
    ssrfGuard = new SsrfGuardService();
    mockAttachmentsService = {
      createAttachment: jest.fn(),
    };
    webSnapshotService = new WebSnapshotService(
      mockAttachmentsService as AttachmentsService,
      undefined,
      ssrfGuard,
    );
  });

  describe('SsrfGuardService — IP & Protocol Filtering', () => {
    it('blocks localhost and loopback IPv4', async () => {
      await expect(
        ssrfGuard.assertSafeUrl('http://127.0.0.1/admin'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://127.0.0.254:8080'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://localhost:3000'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://sub.localhost'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks RFC 1918 private network IPs', async () => {
      await expect(ssrfGuard.assertSafeUrl('http://10.0.0.1')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        ssrfGuard.assertSafeUrl('http://172.16.0.1'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://172.31.255.255'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://192.168.1.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks Cloud Metadata IPs (AWS, GCP, Azure, Alibaba)', async () => {
      // 169.254.169.254 (AWS/GCP/Azure)
      await expect(
        ssrfGuard.assertSafeUrl('http://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow(ForbiddenException);

      // 100.100.100.200 (Alibaba Cloud)
      await expect(
        ssrfGuard.assertSafeUrl('http://100.100.100.200/latest/meta-data/'),
      ).rejects.toThrow(ForbiddenException);

      // metadata.google.internal
      await expect(
        ssrfGuard.assertSafeUrl(
          'http://metadata.google.internal/computeMetadata/v1/',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks IPv6 loopback, link-local, and IPv4-mapped IPv6', async () => {
      await expect(ssrfGuard.assertSafeUrl('http://[::1]')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(ssrfGuard.assertSafeUrl('http://[fe80::1]')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        ssrfGuard.assertSafeUrl('http://[::ffff:127.0.0.1]'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://[::ffff:169.254.169.254]'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks dangerous URL schemes and userinfo credentials', async () => {
      await expect(
        ssrfGuard.assertSafeUrl('file:///etc/passwd'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('gopher://127.0.0.1:6379/_flushall'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('ftp://example.com/file'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        ssrfGuard.assertSafeUrl('http://admin:secret@example.com'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('WebSnapshotService — Hardened SSRF & Size Limits', () => {
    it('rejects capture of metadata IP 169.254.169.254', async () => {
      await expect(
        webSnapshotService.captureHtmlSnapshot(
          'http://169.254.169.254/latest/meta-data/',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects capture of localhost or internal services', async () => {
      await expect(
        webSnapshotService.captureHtmlSnapshot('http://localhost:5432/db'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        webSnapshotService.captureHtmlSnapshot('http://127.0.0.1:8000/chat'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects targets exceeding 10MB Content-Length', async () => {
      const mockSafeFetch = jest
        .spyOn(ssrfGuard, 'safeFetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({
            'content-length': String(15 * 1024 * 1024), // 15MB
            'content-type': 'text/html',
          }),
          body: null,
          text: jest.fn(),
        } as any);

      jest
        .spyOn(ssrfGuard, 'assertSafeUrl')
        .mockResolvedValueOnce(new URL('https://example.com'));

      await expect(
        webSnapshotService.captureHtmlSnapshot(
          'https://example.com/huge-archive.html',
        ),
      ).rejects.toThrow('Target document size exceeds 10MB limit');

      mockSafeFetch.mockRestore();
    });

    it('successfully processes clean HTML within size limits and strips scripts', async () => {
      const testHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Safe Research Paper</title></head>
          <body>
            <h1>Quantum Error Correction</h1>
            <p>This is a safe academic article about quantum computing.</p>
            <script>alert("evil XSS");</script>
            <iframe src="http://evil.com"></iframe>
          </body>
        </html>
      `;

      jest
        .spyOn(ssrfGuard, 'assertSafeUrl')
        .mockResolvedValueOnce(new URL('https://arxiv.org/abs/1234.5678'));
      jest.spyOn(ssrfGuard, 'safeFetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-type': 'text/html',
          'content-length': String(Buffer.byteLength(testHtml)),
        }),
        body: null,
        text: async () => testHtml,
      } as any);

      const snapshot = await webSnapshotService.captureHtmlSnapshot(
        'https://arxiv.org/abs/1234.5678',
      );

      expect(snapshot).toBeDefined();
      expect(snapshot.title).toContain('Quantum Error Correction');
      expect(snapshot.textContent).toContain('quantum computing');
      expect(snapshot.htmlContent).not.toContain('<script>');
      expect(snapshot.htmlContent).not.toContain('evil XSS');
      expect(snapshot.htmlContent).not.toContain('<iframe');
    });
  });
});
