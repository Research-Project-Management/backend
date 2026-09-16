jest.mock('jsdom', () => ({
  JSDOM: jest.fn().mockImplementation(() => ({
    window: { document: {} },
  })),
}));
jest.mock('@mozilla/readability', () => ({
  Readability: jest.fn().mockImplementation(() => ({
    parse: () => null,
  })),
}));
jest.mock('dompurify', () => () => ({
  sanitize: (val: string) => val,
}));

import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { GlobalExceptionFilter } from '@/core/filters/exception.filter';
import { TransformInterceptor } from '@/core/interceptors/transform.interceptor';
import { Reflector } from '@nestjs/core';

describe('App & Core Endpoints (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.DISABLE_REDIS = 'true';
    process.env.NODE_ENV = 'test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    const reflector = app.get(Reflector);
    app.useGlobalInterceptors(new TransformInterceptor(reflector));
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Health Probes', () => {
    it('GET / should return HTTP 200 with service status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('success', true);
      expect(body.data).toHaveProperty('status', 'ok');
      expect(body.data).toHaveProperty('service', 'research-management-api');
    });

    it('GET /health/liveness should return HTTP 200 for container probe', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/liveness',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('success', true);
      expect(body.data).toHaveProperty('status', 'ok');
      expect(body.data).toHaveProperty('timestamp');
    });

    it('GET /health/queues should return HTTP 200 with queue & worker metrics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/queues',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('success', true);
      expect(body.data).toHaveProperty('status', 'ok');
      expect(body.data).toHaveProperty('redis');
      expect(body.data).toHaveProperty('queues');
    });
  });

  describe('Error Handling & Security', () => {
    it('GET /unknown-route-404 should be intercepted by GlobalExceptionFilter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/unknown-route-404',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('statusCode', 404);
      expect(body).toHaveProperty('success', false);
      expect(body.error).toHaveProperty('message');
    });

    it('POST /api/auth/register with empty body should fail validation (HTTP 400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {},
      });

      expect([400, 422]).toContain(response.statusCode);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('statusCode');
    });
  });
});
