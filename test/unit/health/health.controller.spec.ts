import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from '@/health/health.controller';
import { HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { PrismaHealthIndicator } from '@/health/prisma.health';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            check: jest.fn().mockImplementation(() => {
              return { status: 'ok', info: { database: { status: 'up' } } };
            }),
          },
        },
        {
          provide: PrismaHealthIndicator,
          useValue: {
            isHealthy: jest
              .fn()
              .mockResolvedValue({ database: { status: 'up' } }),
          },
        },
        {
          provide: MemoryHealthIndicator,
          useValue: {
            checkHeap: jest
              .fn()
              .mockResolvedValue({ memory_heap: { status: 'up' } }),
            checkRSS: jest
              .fn()
              .mockResolvedValue({ memory_rss: { status: 'up' } }),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return liveness status', () => {
    const res = controller.liveness();
    expect(res.status).toBe('ok');
    expect(res.timestamp).toBeDefined();
  });

  it('should run full health check', async () => {
    const res = await controller.check();
    expect(res.status).toBe('ok');
  });

  it('should run readiness health check', async () => {
    const res = await controller.readiness();
    expect(res.status).toBe('ok');
  });
});
