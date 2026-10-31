/**
 * clsi.ts
 * Dedicated entrypoint for the Common LaTeX Service Interface (CLSI) microservice.
 */

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('tsconfig-paths/register');
} catch {
  // tsconfig-paths is only required during development when paths are not rewritten by tsc-alias
}

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClsiStandaloneModule } from './clsi-standalone.module';

async function bootstrap() {
  const logger = new Logger('CLSI-Service');
  const app = await NestFactory.create<NestFastifyApplication>(
    ClsiStandaloneModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 100 * 1024 * 1024,
    }),
  );

  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Flux Manuscripts - CLSI Service')
    .setDescription(
      'LaTeX Compilation Engine microservice for Flux Manuscripts',
    )
    .setVersion('1.0.0')
    .addTag('CLSI Compilation Engine')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.CLSI_PORT || process.env.PORT || 3013);
  const host = process.env.HOST || '0.0.0.0';

  await app.listen(port, host);
  logger.log(`🚀 [CLSI Service] running on http://${host}:${port}`);
  logger.log(`📚 Swagger documentation at http://${host}:${port}/docs`);
}

bootstrap().catch((err) => {
  console.error('[CLSI Fatal Bootstrap Exception]:', err);
  process.exit(1);
});
