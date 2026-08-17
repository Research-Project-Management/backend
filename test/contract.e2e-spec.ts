import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('System Contract & API Verification Suite (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
    await app.close();
  });

  // ── Health & Base ─────────────────────────────────────────────────────────
  describe('1. Base & Health Contracts', () => {
    it('GET / returns 200 OK', () => {
      return request(app.getHttpServer()).get('/').expect(200);
    });

    it('GET /api/ai/health returns 200 OK without authentication', () => {
      return request(app.getHttpServer()).get('/api/ai/health').expect(200);
    });
  });

  // ── Identity / Auth Contracts ─────────────────────────────────────────────
  describe('2. Identity / Auth Contracts', () => {
    it('GET /auth/me rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer()).get('/auth/me').expect(401);
    });

    it('POST /auth/login validates required fields with 400', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({})
        .expect(400);
    });

    it('POST /auth/register validates email format with 400', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'invalid-email', password: '123' })
        .expect(400);
    });
  });

  // ── Organization Contracts ────────────────────────────────────────────────
  describe('3. Organization Contracts', () => {
    it('GET /api/workspace rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer()).get('/api/workspace').expect(401);
    });

    it('GET /api/workspace/:id/projects rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/workspace/ws-test/projects')
        .expect(401);
    });
  });

  // ── Storage Contracts ─────────────────────────────────────────────────────
  describe('4. Storage Contracts', () => {
    it('POST /api/files/presign rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .post('/api/files/presign')
        .send({ filename: 'test.pdf' })
        .expect(401);
    });

    it('GET /api/workspace/:id/labels rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/workspace/ws-test/labels')
        .expect(401);
    });
  });

  // ── Library Contracts ─────────────────────────────────────────────────────
  describe('5. Library Contracts', () => {
    it('GET /api/library/papers/:workspaceId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/papers/ws-test')
        .expect(401);
    });

    it('GET /api/library/collections/:workspaceId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/library/collections/ws-test')
        .expect(401);
    });
  });

  // ── Manuscript Contracts ──────────────────────────────────────────────────
  describe('6. Manuscript Contracts', () => {
    it('GET /api/project/:projectId/pages rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/project/proj-test/pages')
        .expect(401);
    });

    it('GET /api/pages/:pageId/versions rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/pages/pg-test/versions')
        .expect(401);
    });
  });

  // ── Planning Contracts ────────────────────────────────────────────────────
  describe('7. Planning Contracts', () => {
    it('GET /api/project/:projectId/tasks rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/project/proj-test/tasks')
        .expect(401);
    });

    it('GET /api/project/:projectId/cycles rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/project/proj-test/cycles')
        .expect(401);
    });
  });

  // ── Collaboration Contracts ───────────────────────────────────────────────
  describe('8. Collaboration Contracts', () => {
    it('GET /api/pages/:pageId/comments rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/pages/pg-test/comments')
        .expect(401);
    });

    it('GET /api/tasks/:taskId/comments rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/tasks/t-test/comments')
        .expect(401);
    });

    it('GET /api/workspace/:workspaceId/stickies rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/workspace/ws-test/stickies')
        .expect(401);
    });
  });

  // ── Intelligence Contracts ────────────────────────────────────────────────
  describe('9. Intelligence Contracts', () => {
    it('GET /api/chats rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer()).get('/api/chats').expect(401);
    });
  });

  // ── Analytics Contracts ───────────────────────────────────────────────────
  describe('10. Analytics & Insights Contracts', () => {
    it('GET /api/analytics/workspaces/:workspaceId/overview rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/analytics/workspaces/ws-test/overview')
        .expect(401);
    });

    it('GET /api/analytics/projects/:projectId rejects unauthenticated request with 401', () => {
      return request(app.getHttpServer())
        .get('/api/analytics/projects/proj-test')
        .expect(401);
    });
  });
});
