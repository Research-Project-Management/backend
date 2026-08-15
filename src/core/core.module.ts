import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from './database/prisma.module';
import { CacheModule } from './cache/cache.module';
import { LoggerModule } from './logger/logger.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from './guards/workspace-role.guard';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { TransformInterceptor } from './interceptors/transform.interceptor';

@Global()
@Module({
  imports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret:
          configService.get<string>('JWT_SECRET') || 'your-jwt-secret-here',
        signOptions: {
          expiresIn:
            (configService.get<string>('JWT_EXPIRES_IN') as any) || '15m',
        },
      }),
    }),
  ],
  providers: [
    JwtAuthGuard,
    WorkspaceRoleGuard,
    GlobalExceptionFilter,
    TransformInterceptor,
  ],
  exports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    JwtModule,
    JwtAuthGuard,
    WorkspaceRoleGuard,
    GlobalExceptionFilter,
    TransformInterceptor,
  ],
})
export class CoreModule {}
