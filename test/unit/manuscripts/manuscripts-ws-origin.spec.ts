import { isOriginAllowed } from '@/core/http/setup/allowed-origins';
import { RedisIoAdapter } from '@/core/infrastructure/redis/redis-io.adapter';
import { IncomingMessage } from 'http';

describe('Realtime Origin Allowlist Validation (US6 & RT-30)', () => {
  describe('1. Shared Origin Predicate (isOriginAllowed)', () => {
    it('allows non-browser clients with missing or empty Origin header', () => {
      expect(isOriginAllowed(undefined)).toBe(true);
      expect(isOriginAllowed('')).toBe(true);
      expect(isOriginAllowed(null as any)).toBe(true);
    });

    it('allows trusted local development origins and ports', () => {
      expect(isOriginAllowed('http://localhost:3000')).toBe(true);
      expect(isOriginAllowed('http://localhost:3001/')).toBe(true);
      expect(isOriginAllowed('http://localhost:5173')).toBe(true);
      expect(isOriginAllowed('http://127.0.0.1:3000')).toBe(true);
    });

    it('allows private LAN IP addresses', () => {
      expect(isOriginAllowed('http://192.168.1.100:3000')).toBe(true);
      expect(isOriginAllowed('http://10.0.1.5:8080')).toBe(true);
      expect(isOriginAllowed('http://172.16.0.1:3000')).toBe(true);
    });

    it('allows custom configured client URL and extra origins', () => {
      const options = {
        clientUrl: 'https://app.manuscript.io',
        extraOrigins: ['https://editor.manuscript.io'],
      };

      expect(isOriginAllowed('https://app.manuscript.io', options)).toBe(true);
      expect(isOriginAllowed('https://editor.manuscript.io', options)).toBe(true);
      expect(isOriginAllowed('https://unknown.manuscript.io', options)).toBe(false);
    });

    it('allows vercel.app preview deployments in non-production', () => {
      const options = { nodeEnv: 'development' };
      expect(isOriginAllowed('https://preview-deploy-1.vercel.app', options)).toBe(true);
    });

    it('strictly rejects unauthorized third-party origins', () => {
      expect(isOriginAllowed('https://evil-attacker.com')).toBe(false);
      expect(isOriginAllowed('http://localhost.attacker.com')).toBe(false);
      expect(isOriginAllowed('http://192.168.1.100.attacker.com')).toBe(false);
      expect(isOriginAllowed('https://phishing-overleaf.org')).toBe(false);
    });
  });

  describe('2. RedisIoAdapter Origin & Transport Options', () => {
    let adapter: RedisIoAdapter;

    beforeEach(() => {
      adapter = new RedisIoAdapter();
    });

    it('creates IO server with default maxHttpBufferSize capped at 1 MiB', () => {
      const mockSuperCreate = jest.spyOn(
        Object.getPrototypeOf(RedisIoAdapter.prototype),
        'createIOServer',
      ).mockImplementation((port, options: any) => options);

      const serverOptions = adapter.createIOServer(3000) as any;
      expect(serverOptions.maxHttpBufferSize).toBe(1024 * 1024);
      mockSuperCreate.mockRestore();
    });

    it('enforces allowRequest origin verification during WebSocket upgrade', (done) => {
      const mockSuperCreate = jest.spyOn(
        Object.getPrototypeOf(RedisIoAdapter.prototype),
        'createIOServer',
      ).mockImplementation((port, options: any) => options);

      const serverOptions = adapter.createIOServer(3000) as any;
      expect(typeof serverOptions.allowRequest).toBe('function');

      // 1. Rejected origin
      const badReq = {
        headers: { origin: 'https://evil-attacker.com' },
      } as IncomingMessage;
      serverOptions.allowRequest(badReq, (err: any, success: boolean) => {
        expect(err).toBe('ORIGIN_NOT_ALLOWED');
        expect(success).toBe(false);

        // 2. Allowed origin
        const goodReq = {
          headers: { origin: 'http://localhost:3000' },
        } as IncomingMessage;
        serverOptions.allowRequest(goodReq, (err2: any, success2: boolean) => {
          expect(err2).toBeNull();
          expect(success2).toBe(true);

          // 3. No origin (non-browser)
          const noOriginReq = {
            headers: {},
          } as IncomingMessage;
          serverOptions.allowRequest(noOriginReq, (err3: any, success3: boolean) => {
            expect(err3).toBeNull();
            expect(success3).toBe(true);
            mockSuperCreate.mockRestore();
            done();
          });
        });
      });
    });
  });
});
