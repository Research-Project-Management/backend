import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { WsAuthService } from '@/modules/realtime/core/ws-auth.guard';
import { RealtimeConfigService } from '@/modules/realtime/core/realtime.config';
import { createWsConnectionMiddleware } from '@/modules/realtime/core/ws-connection.middleware';
import {
  RealtimeAuthRequiredException,
  RealtimeErrorCode,
} from '@/modules/realtime/core/ws-errors';

describe('Realtime Connection Authentication (US1 & RT-01 / RT-02)', () => {
  const TEST_SECRET = 'test-secret-at-least-32-chars-long-security-bar';
  let jwtService: JwtService;
  let mockConfigService: jest.Mocked<RealtimeConfigService>;
  let authService: WsAuthService;

  beforeEach(() => {
    jwtService = new JwtService({ secret: TEST_SECRET });
    mockConfigService = {
      getJwtSecret: jest.fn().mockReturnValue(TEST_SECRET),
      getMaxMessageSizeBytes: jest.fn().mockReturnValue(1048576),
      getMaxYjsUpdateSizeBytes: jest.fn().mockReturnValue(524288),
      getMaxDocumentSizeBytes: jest.fn().mockReturnValue(20971520),
      getAuthCacheTtlSeconds: jest.fn().mockReturnValue(30),
      getRateLimits: jest.fn().mockReturnValue({
        cursor: { budgetPerSec: 20, burst: 40 },
        update: { budgetPerSec: 50, burst: 100 },
        chat: { budgetPerSec: 5, burst: 10 },
        joinLeave: { budgetPerSec: 5, burst: 10 },
        maxThrottledConsecutiveWindows: 5,
      }),
    } as unknown as jest.Mocked<RealtimeConfigService>;

    authService = new WsAuthService(jwtService, mockConfigService);
  });

  const createMockSocket = (options: {
    headers?: Record<string, string>;
    auth?: Record<string, any>;
    query?: Record<string, any>;
  }): Socket => {
    return {
      id: 'socket-12345',
      handshake: {
        headers: options.headers || {},
        auth: options.auth || {},
        query: options.query || {},
      },
      data: {},
      disconnect: jest.fn(),
    } as unknown as Socket;
  };

  describe('1. Secret Configuration & Fail-Fast (RT-01)', () => {
    it('fails fast if JWT_SECRET is not configured or empty', async () => {
      mockConfigService.getJwtSecret.mockImplementation(() => {
        throw new Error('JWT_SECRET must be set');
      });

      const socket = createMockSocket({
        auth: { token: 'some.valid.or.invalid.token' },
      });

      await expect(authService.authenticateSocket(socket)).rejects.toThrow(
        /JWT_SECRET must be set/,
      );
    });

    it('never uses a default fallback secret such as "secret"', async () => {
      mockConfigService.getJwtSecret.mockImplementation(() => {
        throw new Error('JWT_SECRET missing');
      });

      const socket = createMockSocket({ auth: { token: 'sample-token' } });
      await expect(authService.authenticateSocket(socket)).rejects.toThrow();
    });
  });

  describe('2. Credential Extraction & URL Rejection (FR-003)', () => {
    it('extracts token from Authorization: Bearer <token> header', () => {
      const socket = createMockSocket({
        headers: { authorization: 'Bearer header-jwt-token' },
      });
      expect(authService.extractToken(socket)).toBe('header-jwt-token');
    });

    it('extracts token from auth.token in handshake payload', () => {
      const socket = createMockSocket({
        auth: { token: 'handshake-auth-jwt-token' },
      });
      expect(authService.extractToken(socket)).toBe('handshake-auth-jwt-token');
    });

    it('strictly rejects token passed in URL query string', () => {
      const socket = createMockSocket({
        query: { token: 'query-param-jwt-token' },
      });
      expect(authService.extractToken(socket)).toBeNull();
    });
  });

  describe('3. Token Verification & Identity Spoofing Immunity (RT-02 / FR-004)', () => {
    it('authenticates a valid JWT token and extracts verified userId', async () => {
      const validToken = jwtService.sign(
        { sub: '00000000-0000-0000-0000-000000000001', name: 'Alice', email: 'alice@example.com' },
        { secret: TEST_SECRET },
      );

      const socket = createMockSocket({ auth: { token: validToken } });
      const session = await authService.authenticateSocket(socket);

      expect(session.authenticated).toBe(true);
      expect(session.userId).toBe('00000000-0000-0000-0000-000000000001');
      expect(session.name).toBe('Alice');
    });

    it('ignores client-claimed handshake userId, name, avatar, color even if valid token present', async () => {
      const validToken = jwtService.sign(
        { sub: '00000000-0000-0000-0000-000000000001', name: 'Alice' },
        { secret: TEST_SECRET },
      );

      const socket = createMockSocket({
        auth: {
          token: validToken,
          userId: 'spoofed-admin-id',
          name: 'Spoofed Admin',
          color: 'javascript:alert(1)',
          avatar: 'data:text/html,bad',
        },
      });

      const session = await authService.authenticateSocket(socket);
      expect(session.userId).toBe('00000000-0000-0000-0000-000000000001');
      expect(session.name).toBe('Alice');
      expect(session.color).not.toBe('javascript:alert(1)');
    });

    it('rejects expired tokens without falling back to anonymous user', async () => {
      const expiredToken = jwtService.sign(
        { sub: '00000000-0000-0000-0000-000000000001' },
        { secret: TEST_SECRET, expiresIn: -10 },
      );

      const socket = createMockSocket({ auth: { token: expiredToken } });
      await expect(authService.authenticateSocket(socket)).rejects.toThrow(
        RealtimeAuthRequiredException,
      );
    });

    it('rejects tokens signed with wrong secret', async () => {
      const fakeToken = jwtService.sign(
        { sub: '00000000-0000-0000-0000-000000000001' },
        { secret: 'wrong-untrusted-secret' },
      );

      const socket = createMockSocket({ auth: { token: fakeToken } });
      await expect(authService.authenticateSocket(socket)).rejects.toThrow(
        RealtimeAuthRequiredException,
      );
    });

    it('rejects connection if no credential is provided (never generates anon-*)', async () => {
      const socket = createMockSocket({});
      await expect(authService.authenticateSocket(socket)).rejects.toThrow(
        RealtimeAuthRequiredException,
      );
    });
  });

  describe('4. Namespace Connection Middleware', () => {
    it('calls next() and populates socket.data when credentials are valid', async () => {
      const middleware = createWsConnectionMiddleware(authService);
      const validToken = jwtService.sign(
        { sub: '00000000-0000-0000-0000-000000000001', name: 'Bob' },
        { secret: TEST_SECRET },
      );

      const socket = createMockSocket({ auth: { token: validToken } });
      const nextFn = jest.fn();

      await middleware(socket, nextFn);

      expect(nextFn).toHaveBeenCalledWith();
      expect(socket.data.authenticated).toBe(true);
      expect(socket.data.userId).toBe('00000000-0000-0000-0000-000000000001');
      expect(socket.data.projectId).toBeNull();
      expect(socket.data.activeDocId).toBeNull();
    });

    it('calls next(error) with AUTH_REQUIRED error when credential is missing', async () => {
      const middleware = createWsConnectionMiddleware(authService);
      const socket = createMockSocket({});
      const nextFn = jest.fn();

      await middleware(socket, nextFn);

      expect(nextFn).toHaveBeenCalledTimes(1);
      const errorArg = nextFn.mock.calls[0][0];
      expect(errorArg).toBeDefined();
      expect(errorArg.name || errorArg.message).toContain('AUTH_REQUIRED');
    });
  });
});
