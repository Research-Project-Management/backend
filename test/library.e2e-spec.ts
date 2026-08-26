import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/core/database/prisma.service';
import { RedisCacheService } from '../src/core/cache/redis-cache.service';

describe('Library (e2e)', () => {
  let app: NestFastifyApplication;
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    try {
      const prisma = moduleFixture.get(PrismaService, { strict: false });
      if (prisma) await prisma.onModuleDestroy();
      const redis = moduleFixture.get(RedisCacheService, { strict: false });
      if (redis) await redis.onModuleDestroy();
    } catch {
      // ignore
    }
    await app.close();
  });

  describe('1. Legacy Catalog & Paper Routes', () => {
    it('GET /api/library/papers/:workspaceId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/papers/ws-1')
        .expect(401);
    });

    it('POST /api/library/papers/:workspaceId/ingest rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .post('/api/library/papers/ws-1/ingest')
        .send({ title: 'Test Paper' })
        .expect(401);
    });

    it('GET /api/library/papers/:workspaceId/:paperId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/papers/ws-1/paper-1')
        .expect(401);
    });

    it('GET /api/workspace/:workspaceId/library/items rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/workspace/ws-1/library/items')
        .expect(401);
    });
  });

  describe('2. Legacy Collections Routes', () => {
    it('GET /api/library/collections/:workspaceId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/collections/ws-1')
        .expect(401);
    });

    it('POST /api/library/collections/:workspaceId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .post('/api/library/collections/ws-1')
        .send({ name: 'Default Collection' })
        .expect(401);
    });

    it('GET /api/workspace/:workspaceId/library/collections rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/workspace/ws-1/library/collections')
        .expect(401);
    });
  });

  describe('3. Legacy Reference & Citation Routes', () => {
    it('GET /api/library/references/doi/:doi rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/references/doi/10.1038%2Fnature12345')
        .expect(401);
    });

    it('GET /api/library/references/:workspaceId/papers/:itemId/citation rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/references/ws-1/papers/p-1/citation')
        .expect(401);
    });
  });

  describe('4. Legacy Quality & Diagnostics Routes', () => {
    it('GET /api/library/quality/:workspaceId/duplicates rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/quality/ws-1/duplicates')
        .expect(401);
    });

    it('GET /api/library/quality/:workspaceId/integrity rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/quality/ws-1/integrity')
        .expect(401);
    });
  });

  describe('5. Sync & Change Routes', () => {
    it('GET /workspaces/:workspaceId/library/changes rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/workspaces/ws-1/library/changes')
        .expect(401);
    });
  });
});
