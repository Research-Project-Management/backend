import { Test, TestingModule } from '@nestjs/testing';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { ConfigService } from '@nestjs/config';

describe('RedisCacheService', () => {
  let service: RedisCacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisCacheService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('redis://localhost:6379'),
          },
        },
      ],
    }).compile();

    service = module.get<RedisCacheService>(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should fallback gracefully on wrap when cache is offline', async () => {
    const fallback = jest.fn().mockResolvedValue({ id: 'res-1', count: 42 });
    const result = await service.wrap('test:key', fallback, 60);

    expect(result).toEqual({ id: 'res-1', count: 42 });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('should not throw on get, set, del, delPattern when client is null/offline', async () => {
    await expect(service.get('key')).resolves.toBeNull();
    await expect(service.set('key', { a: 1 })).resolves.not.toThrow();
    await expect(service.del('key')).resolves.not.toThrow();
    await expect(service.delPattern('key:*')).resolves.not.toThrow();
  });
});
