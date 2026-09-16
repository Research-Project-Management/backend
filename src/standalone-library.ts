process.env.STANDALONE_LIBRARY = 'true';

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('tsconfig-paths/register');
} catch {
  // tsconfig-paths is only required during development
}

import {
  Module,
  Injectable,
  CanActivate,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';

import { JwtModule } from '@nestjs/jwt';

import { CoreModule } from './core/core.module';
import { StorageModule } from './modules/storage/storage.module';
import { LibraryModule } from './modules/library/library.module';
import { JwtAuthGuard } from './modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from './modules/iam/authz/guards/role.guard';
import { PrismaService } from './core/database/prisma.service';
import { LoggerService } from './core/logger/logger.service';
import { TransformInterceptor } from './core/interceptors/transform.interceptor';
import { GlobalExceptionFilter } from './core/filters/exception.filter';

/**
 * MockDevAuthGuard:
 * Allows completely isolated testing of the Library module without requiring
 * external Auth/IAM token validation or redis sessions.
 */
@Injectable()
export class MockDevAuthGuard implements CanActivate {
  private static cachedUser: { id: string; email: string; name: string } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (!MockDevAuthGuard.cachedUser) {
      try {
        const existing = await this.prisma.user.findFirst({
          select: { id: true, email: true, name: true },
        });
        if (existing) {
          MockDevAuthGuard.cachedUser = {
            id: existing.id,
            email: existing.email || 'tester@flux.local',
            name: existing.name || 'Sandbox Tester',
          };
        } else {
          const created = await this.prisma.user.create({
            data: {
              email: 'tester@flux.local',
              name: 'Sandbox Tester',
            },
            select: { id: true, email: true, name: true },
          });
          MockDevAuthGuard.cachedUser = {
            id: created.id,
            email: created.email || 'tester@flux.local',
            name: created.name || 'Sandbox Tester',
          };
        }
      } catch (err: any) {
        console.warn('[Standalone Library] User resolution fallback:', err.message);
        MockDevAuthGuard.cachedUser = {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'sandbox@flux.local',
          name: 'Sandbox Tester',
        };
      }
    }

    const user = MockDevAuthGuard.cachedUser ?? {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'sandbox@flux.local',
      name: 'Sandbox Tester',
    };

    request.user = {
      id: user.id,
      sub: user.id,
      email: user.email,
      name: user.name,
      role: 'OWNER',
    };

    return true;
  }
}

/**
 * MockDevProjectRoleGuard:
 * Automatically grants OWNER access to test projects in sandbox mode.
 */
@Injectable()
export class MockDevProjectRoleGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
    }),
    CoreModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'sandbox-secret',
    }),
    StorageModule,
    LibraryModule,
  ],
  providers: [
    {
      provide: JwtAuthGuard,
      useClass: MockDevAuthGuard,
    },
    {
      provide: ProjectRoleGuard,
      useClass: MockDevProjectRoleGuard,
    },
  ],
})
export class StandaloneLibraryModule {}

async function bootstrap() {
  const logger = LoggerService.getInstance('StandaloneLibrary');

  const app = await NestFactory.create<NestFastifyApplication>(
    StandaloneLibraryModule,
    new FastifyAdapter(),
    {
      logger,
      bufferLogs: true,
    },
  );
  app.useLogger(logger);

  // File upload support (PDFs & BibTeX up to 100MB)
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new TransformInterceptor(reflector));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-workspace-id', 'x-project-id'],
  });

  // Swagger Documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Flux Library & Reader - Standalone Test API')
    .setDescription(
      'Isolated backend micro-kernel providing complete Library, Reader State, and Storage capabilities for testing independent of other platform modules.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT-auth')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT_LIBRARY') || 3005;

  await app.listen(port, '0.0.0.0');
  console.log(`\n======================================================`);
  console.log(`🚀 [Standalone Library] Server is RUNNING on port ${port}`);
  console.log(`📖 Swagger API Docs: http://localhost:${port}/api/docs`);
  console.log(`🛡️ Mock Auth: ENABLED (All calls auto-authenticated as Sandbox Tester)`);
  console.log(`======================================================\n`);
}

bootstrap().catch((err) => {
  console.error('[Standalone Library] Failed to bootstrap:', err);
  process.exit(1);
});
