import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Dashboard (e2e)', () => {
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

  it('/api/dashboard/workspaces/:workspaceId/search (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer())
      .get('/api/dashboard/workspaces/ws-1/search?q=test')
      .expect(401);
  });

  it('/api/dashboard/projects/:projectId/overview (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer())
      .get('/api/dashboard/projects/proj-1/overview')
      .expect(401);
  });
});
