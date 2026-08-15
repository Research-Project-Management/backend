import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Planning (e2e)', () => {
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

  it('/api/project/:projectId/tasks (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer())
      .get('/api/project/proj-1/tasks')
      .expect(401);
  });

  it('/api/project/:projectId/cycles (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer())
      .get('/api/project/proj-1/cycles')
      .expect(401);
  });
});
