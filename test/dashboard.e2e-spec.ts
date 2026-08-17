import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Analytics (e2e)', () => {
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

  it('/api/analytics/workspaces/:workspaceId/overview (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer())
      .get('/api/analytics/workspaces/ws-1/overview')
      .expect(401);
  });

  it('/api/analytics/projects/:projectId (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer())
      .get('/api/analytics/projects/proj-1')
      .expect(401);
  });
});
