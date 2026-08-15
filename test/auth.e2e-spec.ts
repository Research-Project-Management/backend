import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AuthController (e2e)', () => {
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

  it('/auth/register (POST) fails validation on bad email and short password', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'invalid-email', password: '123' })
      .expect(400);
  });

  it('/auth/login (POST) fails validation when body is empty', () => {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({})
      .expect(400);
  });

  it('/auth/me (GET) rejects unauthenticated request with 401', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });
});
