import { WsRateLimiter, classifyEvent } from '@/modules/realtime/core/ws-rate-limiter';
import { RealtimeConfigService } from '@/modules/realtime/core/realtime.config';
import { RealtimeRateLimitedException } from '@/modules/realtime/core/ws-errors';

describe('Realtime WebSocket Rate Limiter (US5 & SC-005 / RT-11)', () => {
  let rateLimiter: WsRateLimiter;
  let mockConfig: RealtimeConfigService;

  beforeEach(() => {
    mockConfig = {
      getRateLimits: () => ({
        cursor: { budgetPerSec: 20, burst: 40 },
        update: { budgetPerSec: 50, burst: 100 },
        chat: { budgetPerSec: 5, burst: 10 },
        joinLeave: { budgetPerSec: 5, burst: 10 },
        maxThrottledConsecutiveWindows: 5,
      }),
    } as any;

    rateLimiter = new WsRateLimiter(mockConfig);
  });

  describe('1. Event Classification', () => {
    it('classifies events into expected rate limiting classes', () => {
      expect(classifyEvent('doc:cursor')).toBe('cursor');
      expect(classifyEvent('doc:update')).toBe('update');
      expect(classifyEvent('doc:sync:step2')).toBe('update');
      expect(classifyEvent('doc:sync:update')).toBe('update');
      expect(classifyEvent('project:chat:send')).toBe('chat');
      expect(classifyEvent('project:join')).toBe('joinLeave');
      expect(classifyEvent('project:leave')).toBe('joinLeave');
      expect(classifyEvent('doc:join')).toBe('joinLeave');
      expect(classifyEvent('doc:leave')).toBe('joinLeave');
      expect(classifyEvent('unknown:event')).toBe('other');
    });
  });

  describe('2. Rate Budget Enforcement & Burst Limits', () => {
    it('allows events within burst budget', () => {
      const mockSocket: any = { id: 'sock-allow-1', disconnect: jest.fn() };

      // Chat burst is 10
      for (let i = 0; i < 10; i++) {
        expect(() =>
          rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
        ).not.toThrow();
      }
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('throws RealtimeRateLimitedException when budget/burst is exceeded', () => {
      const mockSocket: any = { id: 'sock-exceed-1', disconnect: jest.fn() };

      // Consume full burst of 10
      for (let i = 0; i < 10; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }

      // 11th should be throttled
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);

      try {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      } catch (err: any) {
        expect(err.code).toBe('RATE_LIMITED');
        expect(err.retryable).toBe(true);
      }
    });

    it('isolates rate limits per socket (flooding client does not affect peers)', () => {
      const clientA: any = { id: 'sock-flooder-A', disconnect: jest.fn() };
      const clientB: any = { id: 'sock-normal-B', disconnect: jest.fn() };

      // Flood client A
      for (let i = 0; i < 10; i++) {
        rateLimiter.consumeOrThrow(clientA, 'project:chat:send');
      }
      expect(() =>
        rateLimiter.consumeOrThrow(clientA, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);

      // Client B should not be affected
      expect(() =>
        rateLimiter.consumeOrThrow(clientB, 'project:chat:send'),
      ).not.toThrow();
      expect(clientB.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('3. Repeat Offender Auto-Disconnect', () => {
    it('disconnects repeat offenders after 5 consecutive throttled windows', () => {
      const mockSocket: any = { id: 'sock-repeat-1', disconnect: jest.fn() };
      let now = 1000000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      // Consume burst in window 0
      for (let i = 0; i < 10; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }

      // Violate in window 0 (consecutive count = 1)
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();

      // Window 1 (+1000ms): consecutive count = 2
      now += 1000;
      // drain refilled tokens (5 per sec)
      for (let i = 0; i < 5; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();

      // Window 2 (+1000ms): consecutive count = 3
      now += 1000;
      for (let i = 0; i < 5; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();

      // Window 3 (+1000ms): consecutive count = 4
      now += 1000;
      for (let i = 0; i < 5; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();

      // Window 4 (+1000ms): consecutive count = 5 -> Auto Disconnect!
      now += 1000;
      for (let i = 0; i < 5; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).toThrow(RealtimeRateLimitedException);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);

      (Date.now as any).mockRestore();
    });
  });

  describe('4. Lifecycle Cleanup', () => {
    it('removes socket data when cleanupSocket is called', () => {
      const mockSocket: any = { id: 'sock-cleanup-1', disconnect: jest.fn() };
      for (let i = 0; i < 10; i++) {
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send');
      }

      rateLimiter.cleanupSocket(mockSocket.id);

      // Now client should have fresh bucket
      expect(() =>
        rateLimiter.consumeOrThrow(mockSocket, 'project:chat:send'),
      ).not.toThrow();
    });
  });
});
